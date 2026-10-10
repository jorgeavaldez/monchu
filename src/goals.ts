import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export type Goal = {
  id: string;
  title: string;
  owner: "jorge" | "monchu";
  status: "active" | "waiting" | "done" | "dropped";
  /** Absolute directory or repository the goal is about. */
  project?: string;
  /** Names of linked workers. */
  workers: string[];
  next: string;
  updatedAt: number;
};

/** Done and dropped goals kept for `list_goals`; active and waiting goals are always kept. */
const CLOSED_KEPT = 20;

/**
 * The root's goals and commitments. Documents are not transcript, so they survive compaction and `/new`. Open goals keep
 * their creation order; a changed closed goal moves last, so the newest closed goals are the last ones.
 */
export const GoalsDoc = defineDoc<{ goals: Goal[] }>({
  kind: "monchu.goals",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ goals: [] }),
});

/** Asks a summary to keep what the goals section refers to. */
export const GOALS_COMPACTION_FOCUS =
  "Keep every goal id and every open commitment (who owes what, and the next step) verbatim.";

const isOpen = (goal: Goal) => goal.status === "active" || goal.status === "waiting";

/** Stable text for the given goals, in stored order: unchanged goals render identically. */
export function formatGoals(goals: readonly Goal[]): string {
  return goals
    .map((goal) =>
      [
        `- [${goal.id}] ${goal.title} (${goal.status}, owner ${goal.owner})`,
        ...(goal.project === undefined ? [] : [`  project: ${goal.project}`]),
        ...(goal.workers.length === 0 ? [] : [`  workers: ${goal.workers.join(", ")}`]),
        `  next: ${goal.next}`,
      ].join("\n"),
    )
    .join("\n");
}

/** Active and waiting goals, as the prompt section and `/goals` show them. */
export function formatOpenGoals(goals: readonly Goal[]): string {
  const open = goals.filter(isOpen);
  return open.length === 0 ? "No open goals." : formatGoals(open);
}

const text = (maxLength: number, description: string) =>
  Type.String({ minLength: 1, maxLength, pattern: "\\S", description });

/** Root-only: hosts exclude it from the default selection and add it to the root conversation. */
export const Goals = defineExtension({
  name: "monchu.goals",
  sections: [
    section("goals", async (input, context) =>
      formatOpenGoals(
        (await input.read.snapshot(GoalsDoc, input.conversationId, context))?.goals ?? [],
      ),
    ),
  ],
  tools: [
    defineTool({
      name: "update_goal",
      description:
        "Create or patch one goal by id. Creating needs title, owner, and next. Given fields replace stored ones; workers is the full list of linked worker names; an empty project clears it. Returns what changed.",
      parameters: Type.Object(
        {
          id: Type.String({
            pattern: "^[a-z0-9][a-z0-9-]{0,47}$",
            description: "Stable lowercase slug, for example fix-phone-quit",
          }),
          title: Type.Optional(text(200, "What the goal is, in one line")),
          owner: Type.Optional(
            StringEnum(["jorge", "monchu"] as const, {
              description: "jorge for his requests, monchu for your own commitments",
            }),
          ),
          status: Type.Optional(StringEnum(["active", "waiting", "done", "dropped"] as const)),
          project: Type.Optional(
            Type.String({ maxLength: 500, description: "Absolute directory or repository" }),
          ),
          workers: Type.Optional(
            Type.Array(text(100, "Worker name"), { maxItems: 20, uniqueItems: true }),
          ),
          next: Type.Optional(text(1000, "The next step and who takes it")),
        },
        { additionalProperties: false },
      ),
      // One commit that sets the given fields; repeating it changes nothing. Sequential rounds settle each call before the
      // next starts, so recovery never replays an older call over a newer one.
      replay: "safe",
      executionMode: "sequential",
      execute: async (args, api, context) => {
        const { saved, changed } = await api.commit(async (tx) => {
          const state = await tx.doc(GoalsDoc, api.conversationId);
          const now = Date.now();
          const index = state.goals.findIndex((item) => item.id === args.id);
          const goal = state.goals[index];
          const changed: string[] = [];
          if (goal === undefined) {
            if (args.title === undefined || args.owner === undefined || args.next === undefined)
              throw new Error(`No goal ${args.id}; creating one needs title, owner, and next`);
            state.goals.push({
              id: args.id,
              title: args.title,
              owner: args.owner,
              status: args.status ?? "active",
              ...(args.project ? { project: args.project } : {}),
              workers: args.workers ?? [],
              next: args.next,
              updatedAt: now,
            });
            changed.push("created");
          } else {
            const set = <K extends "title" | "owner" | "status" | "next">(
              key: K,
              value: Goal[K] | undefined,
            ) => {
              if (value === undefined || goal[key] === value) return;
              goal[key] = value;
              changed.push(key);
            };
            set("title", args.title);
            set("owner", args.owner);
            set("status", args.status);
            set("next", args.next);
            if (args.project !== undefined && args.project !== (goal.project ?? "")) {
              if (args.project) goal.project = args.project;
              else delete goal.project;
              changed.push("project");
            }
            const workers = args.workers;
            if (
              workers !== undefined &&
              (workers.length !== goal.workers.length ||
                workers.some((name, index) => name !== goal.workers[index]))
            ) {
              goal.workers = workers;
              changed.push("workers");
            }
            if (changed.length > 0) goal.updatedAt = now;
            if (changed.length > 0 && !isOpen(goal)) {
              const moved = { ...goal, workers: [...goal.workers] };
              state.goals.splice(index, 1);
              state.goals.push(moved);
            }
          }
          // Only a created or changed goal can exceed the limit, and it is the newest, so it is kept.
          let closed = 0;
          for (let at = state.goals.length - 1; at >= 0; at--) {
            if (!isOpen(state.goals[at]!) && ++closed > CLOSED_KEPT) state.goals.splice(at, 1);
          }
          const saved = state.goals.find((item) => item.id === args.id);
          if (saved === undefined) throw new Error(`Goal ${args.id} is missing`);
          return { saved: formatGoals([saved]), changed };
        }, context);
        return {
          content: [
            {
              type: "text",
              text: `${changed.length === 0 ? "Unchanged" : `Changed: ${changed.join(", ")}`}\n${saved}`,
            },
          ],
        };
      },
    }),
    defineTool({
      name: "list_goals",
      description:
        "List every retained goal: open ones and the most recent done or dropped ones, with project, workers, and next step.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, context) => {
        const goals = (await api.snapshot(GoalsDoc, api.conversationId, context))?.goals ?? [];
        return {
          content: [{ type: "text", text: goals.length === 0 ? "No goals." : formatGoals(goals) }],
        };
      },
    }),
  ],
});
