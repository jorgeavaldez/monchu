/**
 * The workers menu, a sheet over the editor: the root, then this root's workers in the order picked, one line each
 * (status, name, context used, idle time). Right of the box: stop or close the selection. Its view bar shows or hides
 * the working and idle ones and orders them; a tap on the selected row shows the conversation.
 */
import { age, contextUsage, lastActive, presentation } from "../ui/state.ts";
import { run } from "./commands.ts";
import { Key } from "./keys.tsx";
import { Marked, matching } from "./menu.tsx";
import {
  lookChords,
  orderOf,
  selectedRow,
  SheetBar,
  SheetView,
  showsStatus,
  sortRows,
  tapRow,
  type Order,
  type Segment,
  type SheetSpec,
} from "./sheet.tsx";
import { client, closeSheet, sheet, shown, view, workers, type Sheet } from "./state.ts";

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
    ...workers.value.map((worker) => ({
      name: worker.name,
      busy: worker.busy,
      activeAt: worker.activeAt,
      context: worker.contextTokens,
      model: worker.model,
    })),
  ];
}

const statusOf = (each: Crew) => (each.busy ? "working" : "idle");

const ORDERS: readonly Order[] = [
  { key: "recent", glyph: "◷↓", word: "recent" },
  { key: "name", glyph: "a→z", word: "name" },
  { key: "context", glyph: "%↓", word: "context" },
];
/** Working ones count as active now. */
const lastWorked = (each: Crew) => (each.busy ? Infinity : (each.activeAt ?? 0));
const COMPARE: Record<string, (x: Crew, y: Crew) => number> = {
  recent: (x, y) => lastWorked(y) - lastWorked(x),
  name: (x, y) => (x.name ?? "").localeCompare(y.name ?? ""),
  context: (x, y) => (y.context ?? 0) - (x.context ?? 0),
};

function segments(): Segment[] {
  const all = crew();
  const busy = all.filter((each) => each.busy).length;
  return [
    { key: "working", glyph: "●", tone: "accent", word: "working", count: busy, letter: "w" },
    { key: "idle", glyph: "○", tone: "muted", word: "idle", count: all.length - busy, letter: "i" },
  ];
}

/** The rows shown: the root first, then its workers in the order picked, of the statuses shown, matched by every typed
 * word. */
function crewRows(open: Sheet): Crew[] {
  const all = crew().filter((each) => showsStatus(open.look, statusOf(each)));
  const listed = [
    ...all.filter((each) => each.name === undefined),
    ...sortRows(
      all.filter((each) => each.name !== undefined),
      orderOf(open.look, ORDERS),
      COMPARE,
    ),
  ];
  const byId = new Map(listed.map((each) => [each.name ?? "", each]));
  return matching(
    listed.map((each) => ({ id: each.name ?? "", label: each.name ?? "root" })),
    open.query,
  ).flatMap((item) => byId.get(item.id) ?? []);
}

/** A row's key: the worker's name, empty for the root. */
const keyOf = (each: Crew) => each.name ?? "";

/** The selected row of `rows`. */
const chosen = (open: Sheet, rows: readonly Crew[]): Crew | undefined =>
  rows[selectedRow(open, rows.map(keyOf))];

const selected = (): Crew | undefined => {
  const open = sheet.value;
  return open === undefined ? undefined : chosen(open, crewRows(open));
};

function take(each: Crew | undefined): void {
  if (each === undefined) return;
  closeSheet();
  run("show", each.name);
}

/** Stop a working one: the root's run, or a worker's. */
function stop(each: Crew | undefined): void {
  if (each?.busy !== true) return;
  run("worker.stop", each.name);
}

/** In text presentation, so no system draws it as an emoji. */
const CLOSE = "⏏\uFE0E";

/** Close an idle worker: it leaves the roster and its history stays. The root's front never closes. */
function close(each: Crew | undefined): void {
  if (each?.name === undefined || each.busy) return;
  run("worker.close", each.name);
}

export const WORKERS: SheetSpec = {
  orders: ORDERS,
  keys: () => (sheet.value === undefined ? [] : crewRows(sheet.value).map(keyOf)),
  take: (index) => take(sheet.value === undefined ? undefined : crewRows(sheet.value)[index]),
  chords: () => [
    { key: "s", glyph: "■", label: "stop", run: () => stop(selected()) },
    { key: "x", glyph: CLOSE, label: "close", run: () => close(selected()) },
    ...(sheet.value === undefined ? [] : lookChords(sheet.value.look, segments(), ORDERS, false)),
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

function Row(props: { each: Crew; selected: boolean; query: string }) {
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
      onClick={() => tapRow(WORKERS, keyOf(each))}
    >
      <span class="enter">
        <span
          class={`dot ${each.busy ? "working" : "idle"}`}
          role="img"
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
  const each = chosen(open, rows);
  return (
    <SheetView
      open={open}
      spec={WORKERS}
      label="workers"
      class="rootsMenu workersMenu"
      empty={rows.length > 0 ? undefined : open.query ? "nothing matches" : "none"}
    >
      {rows.map((one) => (
        <Row key={keyOf(one)} each={one} selected={one === each} query={open.query} />
      ))}
    </SheetView>
  );
}

/** Right of the box: stop or close the selection. */
export function WorkersActions({ open }: { open: Sheet }) {
  const each = chosen(open, crewRows(open));
  return (
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
        class="icon"
        label="close"
        title={each?.busy === true ? "a working worker can't be closed" : "close (spc x)"}
        disabled={each?.name === undefined || each.busy}
        onPress={() => close(each)}
      >
        {CLOSE}
      </Key>
    </>
  );
}

export function WorkersBar({ open }: { open: Sheet }) {
  return <SheetBar open={open} segments={segments()} orders={ORDERS} />;
}
