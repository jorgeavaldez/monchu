import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export type Goal = {
  id: string;
  title: string;
  kind: "endeavor" | "commitment";
  status: "active" | "waiting" | "done" | "dropped";
  /** Absolute directory or repository the goal is about. */
  project?: string;
  /** Canonical vault note, for example projects/monchu. */
  vault?: string;
  /** What is happening now in this ongoing project or commitment. */
  workstream: string;
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
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ goals: [] }),
});

/** Asks a summary to keep what the goals section refers to. */
export const GOALS_COMPACTION_FOCUS =
  "Keep every open goal id, kind (endeavor or commitment), title, project and vault links, current workstream, next step, and linked workers verbatim. Goals are ongoing projects or workstreams, or Monchu's own commitments, never single requests.";

const isOpen = (goal: Goal) => goal.status === "active" || goal.status === "waiting";

// Stored text may carry its own line breaks; continuation lines stay indented under their field.
const field = (label: string, value: string) =>
  `  ${label}: ${value.split(/\r\n|\r|\n/).join("\n    ")}`;

/** Stable text for the given goals, in stored order: unchanged goals render identically. */
function formatGoals(goals: readonly Goal[]): string {
  return goals
    .map((goal) =>
      [
        `- [${goal.id}] ${goal.title.replace(/\s*[\r\n]+\s*/g, " ")} (${goal.status}, ${goal.kind})`,
        ...(goal.project === undefined ? [] : [field("project", goal.project)]),
        ...(goal.vault === undefined ? [] : [field("vault", goal.vault)]),
        field("workstream", goal.workstream),
        ...(goal.workers.length === 0 ? [] : [field("workers", goal.workers.join(", "))]),
        field("next", goal.next),
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

/**
 * Root-only: hosts exclude it from the default selection and add it to the root conversation.
 * @public Loaded by the reload manifest (src/reload.ts).
 */
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
        "Create or patch one ongoing project/workstream (endeavor) or Monchu's own commitment, never a single request. When a request touches a project, update its existing goal's current workstream, next step and workers. Creating needs title, kind, workstream, and next; include project and the canonical vault note when available. Given fields replace stored ones; workers is the full list of linked worker names; an empty project or vault clears that link. Returns what changed.",
      parameters: Type.Object(
        {
          id: Type.String({
            pattern: "^[a-z0-9][a-z0-9-]{0,47}$",
            description: "Stable ongoing-project slug, for example monchu",
          }),
          title: Type.Optional(text(200, "What the goal is, in one line")),
          kind: Type.Optional(
            StringEnum(["endeavor", "commitment"] as const, {
              description:
                "endeavor for the user's ongoing projects, commitment for Monchu's own promises",
            }),
          ),
          status: Type.Optional(StringEnum(["active", "waiting", "done", "dropped"] as const)),
          project: Type.Optional(
            Type.String({ maxLength: 500, description: "Absolute directory or repository" }),
          ),
          vault: Type.Optional(
            Type.String({
              maxLength: 500,
              description: "Canonical vault note, for example projects/monchu",
            }),
          ),
          workstream: Type.Optional(
            text(1000, "What is happening now in this ongoing project or commitment"),
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
            if (
              args.title === undefined ||
              args.kind === undefined ||
              args.workstream === undefined ||
              args.next === undefined
            )
              throw new Error(
                `No goal ${args.id}; creating one needs title, kind, workstream, and next`,
              );
            state.goals.push({
              id: args.id,
              title: args.title,
              kind: args.kind,
              status: args.status ?? "active",
              ...(args.project ? { project: args.project } : {}),
              ...(args.vault ? { vault: args.vault } : {}),
              workstream: args.workstream,
              workers: args.workers ?? [],
              next: args.next,
              updatedAt: now,
            });
            changed.push("created");
          } else {
            const set = <K extends "title" | "kind" | "status" | "workstream" | "next">(
              key: K,
              value: Goal[K] | undefined,
            ) => {
              if (value === undefined || goal[key] === value) return;
              goal[key] = value;
              changed.push(key);
            };
            set("title", args.title);
            set("kind", args.kind);
            set("status", args.status);
            set("workstream", args.workstream);
            set("next", args.next);
            for (const key of ["project", "vault"] as const) {
              const value = args[key];
              if (value === undefined || value === (goal[key] ?? "")) continue;
              if (value) goal[key] = value;
              else delete goal[key];
              changed.push(key);
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
            const goal = state.goals[at];
            if (goal !== undefined && !isOpen(goal) && ++closed > CLOSED_KEPT)
              state.goals.splice(at, 1);
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
        "List retained ongoing endeavors and Monchu's commitments: open ones and the most recent done or dropped ones, with kind, project and vault links, current workstream, workers, and next step.",
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
