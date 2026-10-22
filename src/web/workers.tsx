/**
 * The workers menu, a sheet over the editor: the root, then this root's workers, working ones first, one line each
 * (status, name, context used, idle time). Its bar stops the selection and shows only the working ones or all; a tap
 * or › shows the conversation.
 */
import { age, contextUsage, lastActive, presentation } from "../ui/state.ts";
import { run } from "./commands.ts";
import { Key } from "./keys.tsx";
import { Marked, matching } from "./menu.tsx";
import { SheetView, tapRow, type SheetSpec } from "./sheet.tsx";
import {
  client,
  closeSheet,
  sheet,
  shown,
  updateSheet,
  view,
  workers,
  type Sheet,
} from "./state.ts";

/** A conversation as a row: undefined names the root's front. */
type Crew = {
  name: string | undefined;
  busy: boolean;
  activeAt: number | undefined;
  context: number | undefined;
  model: string | undefined;
};

function crew(): Crew[] {
  const front = view(undefined)?.value;
  const live = front === undefined ? undefined : presentation(front);
  return [
    {
      name: undefined,
      busy: live?.busy === true,
      activeAt: front === undefined ? undefined : lastActive(front),
      context: front === undefined ? undefined : contextUsage(front).context,
      model: live?.provider === undefined ? undefined : `${live.provider}/${live.model}`,
    },
    ...workers.value
      .toSorted((x, y) => Number(y.busy) - Number(x.busy))
      .map((worker) => ({
        name: worker.name,
        busy: worker.busy,
        activeAt: worker.activeAt,
        context: worker.contextTokens,
        model: worker.model,
      })),
  ];
}

/** The rows shown: every one or the working ones, matched by every typed word. */
function crewRows(open: Sheet): Crew[] {
  const listed = crew().filter((each) => open.filter !== "working" || each.busy);
  const byId = new Map(listed.map((each) => [each.name ?? "", each]));
  return matching(
    listed.map((each) => ({ id: each.name ?? "", label: each.name ?? "root" })),
    open.query,
  ).flatMap((item) => byId.get(item.id) ?? []);
}

const selected = (): Crew | undefined => {
  const open = sheet.value;
  return open === undefined ? undefined : crewRows(open)[open.selected];
};

function take(each: Crew | undefined): void {
  if (each === undefined) return;
  closeSheet();
  run("show", each.name);
}

/** Stop a working one: the root's run, or a worker's. */
function stop(each: Crew | undefined): void {
  if (each?.busy !== true) return;
  if (each.name === undefined) run("stop");
  else run("send", `/stop ${each.name}`);
}

function filterTo(filter: Sheet["filter"]): void {
  updateSheet({ filter, selected: 0 });
}

export const WORKERS: SheetSpec = {
  count: () => (sheet.value === undefined ? 0 : crewRows(sheet.value).length),
  take: (index) => take(sheet.value === undefined ? undefined : crewRows(sheet.value)[index]),
  chords: () => [
    { key: "s", glyph: "■", label: "stop", run: () => stop(selected()) },
    {
      key: "f",
      glyph: "●",
      label: "filter…",
      more: [
        { key: "a", glyph: "∗", label: "all", run: () => filterTo("all") },
        { key: "w", glyph: "●", label: "working", run: () => filterTo("working") },
      ],
    },
  ],
};

/** Context used against the model's window, as the status bar's meter colors it; nothing while unknown. */
function Context({ tokens, model }: { tokens: number | undefined; model: string | undefined }) {
  const slash = model?.indexOf("/") ?? -1;
  const window =
    model === undefined || slash < 0
      ? undefined
      : client().model({ provider: model.slice(0, slash), modelId: model.slice(slash + 1) })
          ?.contextWindow;
  const fill = tokens === undefined || window === undefined ? undefined : tokens / window;
  return (
    <span
      class={`count${fill === undefined ? "" : fill > 0.9 ? " red" : fill > 0.7 ? " yellow" : ""}`}
      title={`context used${model === undefined ? "" : ` · ${model}`}`}
    >
      {fill === undefined ? "" : `${Math.round(fill * 100)}%`}
    </span>
  );
}

function Row(props: { each: Crew; index: number; selected: boolean; query: string }) {
  const { each } = props;
  const here = each.name === shown.value;
  return (
    <li
      role="option"
      aria-selected={props.selected}
      class={`${here ? "here" : ""}${props.selected ? " selected" : ""}`}
      aria-current={here}
      // A tap must not take focus from the editor, or the keyboard closes.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => tapRow(WORKERS, props.index)}
    >
      <span class="enter">
        <span
          class={`dot ${each.busy ? "working" : "idle"}`}
          aria-label={each.busy ? "working" : "idle"}
        >
          {each.busy ? "●" : "○"}
        </span>
        <span class="name">
          <Marked text={each.name ?? "root"} query={props.query} />
        </span>
        <Context tokens={each.context} model={each.model} />
        <span class="age" title="since it last worked">
          {each.busy || each.activeAt === undefined ? "" : age(each.activeAt)}
        </span>
      </span>
    </li>
  );
}

export function WorkersSheet({ open }: { open: Sheet }) {
  const rows = crewRows(open);
  const each = rows[open.selected];
  const working = open.filter === "working";
  const busy = crew().filter((one) => one.busy).length;
  return (
    <SheetView
      open={open}
      spec={WORKERS}
      label="workers"
      class="rootsMenu workersMenu"
      actions={
        <>
          <Key
            class="icon"
            label="stop"
            title="stop (spc s)"
            disabled={each?.busy !== true}
            onPress={() => stop(each)}
          >
            ■
          </Key>
          <Key
            class="filter"
            label={working ? "filter: working" : "filter: all"}
            title={`${working ? "working only" : "all"} · tap for ${working ? "all" : "working only"} (spc f)`}
            pressed={working}
            onPress={() => filterTo(working ? "all" : "working")}
          >
            <span class="dot working">●</span>
            {busy}
          </Key>
        </>
      }
    >
      {rows.length === 0 ? (
        <li class="help empty">{open.query ? "nothing matches" : "none working"}</li>
      ) : null}
      {rows.map((one, index) => (
        <Row
          key={one.name ?? ""}
          each={one}
          index={index}
          selected={index === open.selected}
          query={open.query}
        />
      ))}
    </SheetView>
  );
}
