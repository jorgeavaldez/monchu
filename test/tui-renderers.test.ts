import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import { AssistantEntry, ToolResultEntry, type JsonObject } from "@earendil-works/pi-durable";
import { visibleWidth, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MonchuTui } from "../src/tui/view.ts";
import { initTheme } from "../src/tui/theme/theme.ts";
import { cleanup, context, open, setup } from "./support.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(cleanup);

const lines = Array.from({ length: 30 }, (_, index) => `output-line-${index + 1}`).join("\n");
const pixel: ImageContent = {
  type: "image",
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
};
const cases: {
  name: string;
  args: JsonObject;
  text: string;
  details?: JsonValue;
  image?: ImageContent;
  collapsed: string;
  expanded: string;
  hidden?: string;
  isError?: boolean;
}[] = [
  {
    name: "bash",
    args: { command: "printf shell", timeout: 3 },
    text: lines,
    collapsed: "$ printf shell",
    expanded: "output-line-1",
    hidden: "output-line-1",
  },
  {
    name: "powershell",
    args: { command: "Write-Output shell" },
    text: lines,
    collapsed: "PS> Write-Output shell",
    expanded: "output-line-1",
    hidden: "output-line-1",
  },
  {
    name: "read",
    args: { path: "fixture.ts", offset: 2, limit: 3 },
    text: "const readBody = 42;",
    collapsed: "fixture.ts:2-4",
    expanded: "const readBody = 42;",
    hidden: "readBody",
  },
  {
    name: "write",
    args: { path: "fixture.ts", content: lines },
    text: "Successfully wrote fixture.ts",
    collapsed: "write",
    expanded: "output-line-30",
    hidden: "output-line-30",
  },
  {
    name: "edit",
    args: { path: "fixture.ts", edits: [{ oldText: "old", newText: "new" }] },
    text: "Successfully replaced 1 block",
    details: { diff: "-1 old\n+1 new" },
    collapsed: "-1 old",
    expanded: "+1 new",
  },
  {
    name: "grep",
    args: { pattern: "needle", path: ".", glob: "*.ts", limit: 2 },
    text: "fixture.ts:1: needle",
    details: { matchLimitReached: 2 },
    collapsed: "/needle/",
    expanded: "2 matches limit",
  },
  {
    name: "find",
    args: { pattern: "*.ts", path: ".", limit: 2 },
    text: "fixture.ts",
    details: { resultLimitReached: 2 },
    collapsed: "find *.ts",
    expanded: "2 results limit",
  },
  {
    name: "ls",
    args: { path: ".", limit: 2 },
    text: "fixture.ts",
    details: { entryLimitReached: 2 },
    collapsed: "ls",
    expanded: "2 entries limit",
  },
  {
    name: "write",
    args: { path: "fixture.ts", content: "body" },
    text: "WRITE FAILED",
    isError: true,
    collapsed: "WRITE FAILED",
    expanded: "WRITE FAILED",
  },
  {
    name: "read",
    args: { path: 7 },
    text: "INVALID PATH",
    isError: true,
    collapsed: "[invalid arg]",
    expanded: "INVALID PATH",
  },
  {
    name: "custom",
    args: { note: "fixture", nested: { key: "value" } },
    text: lines,
    collapsed: "custom",
    expanded: "output-line-30",
    hidden: "output-line-30",
  },
  {
    name: "image",
    args: {},
    text: "",
    image: pixel,
    collapsed: "[Image: [image/png] 1x1]",
    expanded: "[Image: [image/png] 1x1]",
  },
  {
    name: "custom",
    args: {},
    text: "\x1b[31mCOLORED\x1b[0m\r\nCONTROL\x00",
    collapsed: "COLORED",
    expanded: "CONTROL",
  },
];

// Passive writes exercise committed Durable views without running shell tools or reading live files.
it.each([
  { theme: "dark", columns: 40 },
  { theme: "light", columns: 60 },
])(
  "renders every built-in and generic fallback from Durable calls/results ($theme, $columns columns)",
  async ({ theme, columns }) => {
    const value = await setup();
    await writeFile(join(value.directory, "fixture.ts"), "PRIVATE DISK CONTENT");
    const { harness, root } = await open(value);
    const state = await root.viewState(context);
    initTheme(theme);
    setCapabilityOverrides({ images: null });
    const screen = new VirtualTerminal(columns, 80);
    const ui = new MonchuTui(screen, value.directory, {
      submit: () => {},
      editQueued: () => {},
      abort: () => {},
      exit: () => {},
    });
    const stop = state.subscribe((view) => ui.apply(view));
    try {
      ui.start();
      for (const [index, fixture] of cases.entries()) {
        await root.reset(undefined, context);
        const call = fauxToolCall(fixture.name, fixture.args);
        await (
          await root.submit(
            {
              type: "write",
              entry: {
                kind: AssistantEntry.kind,
                model: [fauxAssistantMessage([call], { stopReason: "toolUse" })],
              },
            },
            context,
          )
        ).wait(context);
        await (
          await root.submit(
            {
              type: "write",
              entry: {
                kind: ToolResultEntry.kind,
                model: [
                  {
                    role: "toolResult",
                    toolName: fixture.name,
                    toolCallId: call.id,
                    content: [
                      { type: "text", text: fixture.text },
                      ...(fixture.image === undefined ? [] : [fixture.image]),
                    ],
                    isError: fixture.isError ?? false,
                    ...(fixture.details === undefined ? {} : { details: fixture.details }),
                    timestamp: index,
                  },
                ],
                data: { diagnostics: [] },
              },
            },
            context,
          )
        ).wait(context);
        ui.ui.scrollToTop();
        ui.ui.renderNow(true);
        const collapsed = await screen.flushAndGetViewport();
        expect(collapsed.join("\n"), fixture.name).toContain(fixture.collapsed);
        if (fixture.hidden)
          expect(collapsed.join("\n"), fixture.name).not.toContain(fixture.hidden);
        screen.sendInput("\x0f");
        ui.ui.scrollToTop();
        ui.ui.renderNow(true);
        const expanded = await screen.flushAndGetViewport();
        expect(expanded.join("\n"), fixture.name).toContain(fixture.expanded);
        expect(expanded.join("\n")).not.toContain("PRIVATE DISK CONTENT");
        expect([...collapsed, ...expanded].every((line) => visibleWidth(line) <= columns)).toBe(
          true,
        );
        screen.sendInput("\x0f");
      }
      expect(value.reports).toEqual([]);
    } finally {
      stop();
      state.dispose();
      ui.stop();
      setCapabilityOverrides({});
      await harness.close(context);
    }
  },
);
