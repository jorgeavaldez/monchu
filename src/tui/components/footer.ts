/*
Adapted from Pi packages/coding-agent/src/modes/interactive/components/footer.ts.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { theme } from "../theme/theme.ts";
import type { RootStatus } from "../../api/client.ts";
import type { ContextUsage } from "../../ui/state.ts";

/** Pi's compact token count: 999, 1.2k, 45k, 1.2M. */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** A path under the home directory as `~/...`, as Pi's footer shows it. */
export function shortPath(path: string): string {
  const home = resolve(homedir());
  const inside = relative(home, resolve(path));
  if (inside === "") return "~";
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return path;
  return `~${sep}${inside}`;
}

/** A root's status as the indicator draws it: working and done as dots, idle as a hollow one. */
export function rootMark(status: RootStatus, shown = false): string {
  if (status === "idle") return theme.fg("dim", "○");
  return theme.fg(status === "working" ? "accent" : "success", shown ? "◉" : "●");
}

/** A root id as jj shows one: the unique prefix in the warning color, the rest dim. */
export function rootIdText(split: { unique: string; rest: string }): string {
  return theme.fg("warning", split.unique) + theme.fg("dim", split.rest);
}

/** One conversation's context: its usage and its model's context window, when the model is known. */
export type Meter = { usage: ContextUsage; window: number | undefined };

/** Context fill as Pi shows it, `23.4%/272k`, colored at 70% and 90%; `?` until a reply measures it. */
export function meterText(meter: Meter): string {
  const { context } = meter.usage;
  if (meter.window === undefined || meter.window <= 0)
    return theme.fg("dim", context === undefined ? "?" : formatTokens(context));
  const window = formatTokens(meter.window);
  if (context === undefined) return theme.fg("dim", `?/${window}`);
  const percent = (context / meter.window) * 100;
  const text = `${percent.toFixed(1)}%/${window}`;
  return theme.fg(percent > 90 ? "error" : percent > 70 ? "warning" : "dim", text);
}

export type FooterState = {
  cwd: string;
  /** The shown root's id, split at its unique prefix, and label. */
  rootId: { unique: string; rest: string } | undefined;
  rootLabel: string;
  /** The root indicator: one dot per active root. */
  roots: readonly { status: Exclude<RootStatus, "idle">; shown: boolean }[];
  /** The shown conversation: undefined for the root. */
  worker: string | undefined;
  steer: boolean;
  editing: boolean;
  /** The shown conversation's context, then the root's while a worker is shown. */
  shown: Meter | undefined;
  root: Meter | undefined;
  model: string;
  /** Undefined for a model without reasoning. */
  thinking: string | undefined;
  autoCompact: boolean;
};

/** `left` and `right` on one row, right-aligned; the right side is cut first. */
function spread(left: string, right: string, width: number): string {
  const leftWidth = visibleWidth(left);
  if (leftWidth >= width) return truncateToWidth(left, width, theme.fg("dim", "..."));
  const room = width - leftWidth - 2;
  if (room <= 0) return left;
  const cut = truncateToWidth(right, room, "");
  return `${left}${" ".repeat(width - leftWidth - visibleWidth(cut))}${cut}`;
}

/**
 * Pi's two-line footer: the root dots, directory, shown root and worker with the input mode, then token totals, context fill and
 * model. On a worker the root's context stays beside the worker's. Narrow terminals drop totals before context.
 */
export class Footer implements Component {
  state: FooterState = {
    cwd: "",
    rootId: undefined,
    rootLabel: "",
    roots: [],
    worker: undefined,
    steer: false,
    editing: false,
    shown: undefined,
    root: undefined,
    model: "",
    thinking: undefined,
    autoCompact: true,
  };

  render(full: number): string[] {
    // One column of padding each side, as the dock's other rows have.
    const width = Math.max(1, full - 2);
    const state = this.state;
    const dim = (text: string) => theme.fg("dim", text);
    // The root dots and the shown root and worker stay on a narrow screen: the directory gives way first, then the label.
    const dots = state.roots.map((root) => rootMark(root.status, root.shown)).join("");
    const lead = dots ? `${dots} ` : "";
    const view = `${dim(" • ")}${state.rootId === undefined ? dim("root") : rootIdText(state.rootId)}`;
    const worker = state.worker === undefined ? "" : dim(` • ${state.worker}`);
    const mode = state.editing
      ? theme.fg("warning", "editing · Enter saves · Esc cancels")
      : state.steer
        ? `${theme.fg("warning", "steer")}${dim(" (Alt+S)")}`
        : dim("follow-up (Alt+S)");
    const modeWidth = visibleWidth(mode);
    let room = Math.max(0, width - modeWidth - 2 - visibleWidth(lead + view + worker));
    const label =
      state.rootLabel && room > 4
        ? dim(` ${truncateToWidth(state.rootLabel, Math.min(room, 24) - 1, "…")}`)
        : "";
    room -= visibleWidth(label);
    const cwd = room >= 6 ? dim(truncateToWidth(shortPath(state.cwd), room, "...")) : "";
    const cut = truncateToWidth(
      `${lead}${cwd}${view}${label}${worker}`,
      Math.max(0, width - modeWidth - 2),
      "",
    );
    const placeLine =
      modeWidth + 2 >= width
        ? truncateToWidth(mode, width, "")
        : `${cut}${" ".repeat(width - visibleWidth(cut) - modeWidth)}${mode}`;

    const usage = state.shown?.usage;
    const totals = [
      ...(usage?.input ? [`↑${formatTokens(usage.input)}`] : []),
      ...(usage?.output ? [`↓${formatTokens(usage.output)}`] : []),
      ...(usage?.cacheRead ? [`R${formatTokens(usage.cacheRead)}`] : []),
      ...(usage?.cacheWrite ? [`W${formatTokens(usage.cacheWrite)}`] : []),
    ].join(" ");
    const meters = [
      ...(state.shown === undefined
        ? []
        : [
            `${state.worker === undefined ? "" : dim(`${state.worker} `)}${meterText(state.shown)}`,
          ]),
      ...(state.worker === undefined || state.root === undefined
        ? []
        : [`${dim("root ")}${meterText(state.root)}`]),
    ].join(dim(" · "));
    const auto = state.autoCompact && meters ? dim(" (auto)") : "";
    const model = dim(
      state.thinking === undefined ? state.model : `${state.model} • ${state.thinking}`,
    );
    const lefts = [
      ...(totals ? [`${dim(totals)} ${meters}${auto}`] : []),
      `${meters}${auto}`,
      meters,
    ];
    const left =
      lefts.find((line) => visibleWidth(line) + 2 + visibleWidth(model) <= width) ?? meters;
    return [` ${placeLine}`, ` ${spread(left, model, width)}`];
  }

  invalidate(): void {}
}
