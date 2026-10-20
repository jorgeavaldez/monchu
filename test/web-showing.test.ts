import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxItem } from "../src/api/client.ts";
import { Monchu } from "../src/core/backend.ts";
import { Showing } from "../src/web/showing.ts";
import { cleanup, fauxRole, prepareHome, route, setup, waitFor } from "./support.ts";

afterEach(cleanup);

describe("a root's showing in the web page", () => {
  it("keeps nothing that arrives after it closed: views, subscriptions and notices", async () => {
    const value = await setup();
    const home = join(value.directory, "home");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({ front: fauxRole, worker: fauxRole, plugins: { classifier: null } }),
    );
    prepareHome(home);
    route(value.faux, () => fauxAssistantMessage("ok"));
    const backend = await Monchu.open(home, value.faux.provider);
    try {
      const id = await backend.currentRoot();
      const posted: string[] = [];
      const show = () => new Showing(id, backend.root(id), (text) => posted.push(text));

      // The page moved on while the view was on its way: it never lands.
      const left = show();
      const arriving = left.attach(undefined);
      left.close();
      await arriving;
      expect(left.views.value.size).toBe(0);
      left.notice("late");
      expect(posted).toEqual([]);

      // A showing still open follows its root; one closed stops following, and so does a subscription taken after.
      const open = show();
      const closed = show();
      await open.attach(undefined);
      await closed.attach(undefined);
      let heard: readonly InboxItem[] = [];
      let late: readonly InboxItem[] = [];
      open.own(await open.root.watchInbox((items) => (heard = items)));
      closed.close();
      expect(
        closed.own(
          await closed.root.watchInbox((items) => {
            late = items;
          }),
        ),
      ).toBe(false);
      const before = closed.views.value.get("")?.state.value.entries.length;
      await open.root.submit("hello", "r1", "followUp");
      await waitFor(() => heard.length > 0);
      const now = () => open.views.value.get("")?.state.value.entries.length ?? 0;
      await waitFor(() => now() > (before ?? 0));
      expect(closed.views.value.get("")?.state.value.entries.length).toBe(before);
      expect(late).toEqual([]);
      open.notice("shown");
      expect(posted).toEqual(["shown"]);
      open.close();
    } finally {
      await backend.close();
    }
  });
});
