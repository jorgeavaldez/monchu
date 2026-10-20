/**
 * Plugins' page modules: the core lists the ones whose plugin is on (`Client.pages`), each one self-contained hashed
 * file from the web build, and this loads them after the page is up, again after a reload changes the list. A module's
 * default export gets the page API below and may return a dispose function; whatever it registered through the API is
 * dropped with it. A module is trusted code: it runs with the person's full authority in this page, like the plugin
 * it comes with.
 */
import type { Client } from "../api/client.ts";
import type { KeyHandler, KeyOwner, Overlay, PageApi, PageSnapshot } from "../plugin.ts";
import { presentation } from "../ui/state.ts";
import { actions, pluginKeys, runAction } from "./commands.ts";
import {
  ask,
  choice,
  editing,
  escapeLeaves,
  loginStatus,
  menuOpen,
  notice,
  pageHint,
  panel,
  shown,
  view,
} from "./state.ts";

/** One loaded module: what it registered, dropped together. */
type Scope = { plugin: string; handlers: KeyHandler[]; dispose: () => void };

const loaded = new Map<string, Scope>();
let generation = 0;
let listening = false;

function owner(): KeyOwner {
  const element = document.activeElement;
  if (element === null || element === document.body) return "page";
  if (element instanceof HTMLTextAreaElement && element.closest(".editor") !== null)
    return "prompt";
  // A control keeps Enter and Space, in the transcript too.
  if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement) return "button";
  return isField(element) ? "other" : "page";
}

function isField(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function overlay(): Overlay {
  if (
    loginStatus.value !== undefined ||
    choice.value?.requested === true ||
    ask.value?.requested === true
  )
    return "login";
  if (choice.value !== undefined) return "pick";
  if (ask.value !== undefined) return "ask";
  if (panel.value !== undefined) return "panel";
  return menuOpen.value ? "menu" : "none";
}

/** The page as a module sees it; `busy` is worked out only when read, as a key handler seldom needs it. */
function snapshot(): PageSnapshot {
  return {
    owner: owner(),
    overlay: overlay(),
    editing: editing.value !== undefined,
    get busy() {
      const state = view(undefined)?.value;
      return shown.value === undefined && state !== undefined && presentation(state).busy;
    },
  };
}

/** One listener ahead of the page's own: each module's handlers in turn, until one takes the key. */
function listen(): void {
  if (listening) return;
  listening = true;
  addEventListener(
    "keydown",
    (event) => {
      if (loaded.size === 0) return;
      const now = snapshot();
      for (const scope of loaded.values())
        for (const handler of scope.handlers) {
          let taken = false;
          try {
            taken = handler(event, now);
          } catch (error) {
            notice(`${scope.plugin} page module · ${message(error)}`, "warning");
          }
          if (taken) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
    },
    { capture: true },
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Load the listed modules, drop the ones no longer listed; a slower load from an older list drops itself. */
async function apply(list: readonly { plugin: string; url: string }[]): Promise<void> {
  const mine = ++generation;
  for (const [url, scope] of loaded)
    if (!list.some((page) => page.url === url)) {
      loaded.delete(url);
      scope.dispose();
    }
  await Promise.all(
    list
      .filter((page) => !loaded.has(page.url))
      .map(async (page) => {
        let setup: unknown;
        try {
          const module: unknown = await import(page.url);
          setup =
            typeof module === "object" && module !== null
              ? Reflect.get(module, "default")
              : undefined;
        } catch (error) {
          return notice(`${page.plugin} page module didn't load · ${message(error)}`, "warning");
        }
        if (typeof setup !== "function")
          return notice(`${page.plugin} page module has no default function`, "warning");
        if (mine !== generation || loaded.has(page.url)) return;
        const handlers: KeyHandler[] = [];
        let rows: readonly { keys: string; label: string }[] = [];
        let escapes = false;
        let ended: (() => void) | undefined;
        const scope: Scope = {
          plugin: page.plugin,
          handlers,
          dispose: () => {
            handlers.length = 0;
            pluginKeys.value = pluginKeys.value.filter((row) => !rows.includes(row));
            if (escapes) escapeLeaves.value = false;
            pageHint.value = undefined;
            try {
              ended?.();
            } catch (error) {
              notice(`${page.plugin} page module · ${message(error)}`, "warning");
            }
          },
        };
        const api: PageApi = {
          version: 1,
          actions,
          run: runAction,
          snapshot,
          onKey: (handler) => void handlers.push(handler),
          keys: (next) => {
            pluginKeys.value = [...pluginKeys.value.filter((row) => !rows.includes(row)), ...next];
            rows = next;
          },
          escape: (policy) => {
            escapes = policy === "leave";
            escapeLeaves.value = escapes;
          },
          hint: (text) => {
            pageHint.value = text;
          },
          notice: (text) => notice(text),
        };
        loaded.set(page.url, scope);
        try {
          const result: unknown = Reflect.apply(setup, undefined, [api]);
          if (typeof result === "function") ended = () => void Reflect.apply(result, undefined, []);
        } catch (error) {
          loaded.delete(page.url);
          scope.dispose();
          notice(`${page.plugin} page module failed · ${message(error)}`, "warning");
        }
      }),
  );
}

/** Load the core's page modules now and after every reload. */
export function startPages(core: Client): void {
  listen();
  void apply(core.pages());
  core.onReload(() => void apply(core.pages()));
}
