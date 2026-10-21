/**
 * The messages of a conversation as people see them: which entries are messages with a short id, when each was sent,
 * and who sent what text. Shared by the core, which keeps saved messages, and every client.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import { messageParts } from "./attachments.ts";
import {
  parseJobNotice,
  parseReply,
  parseRootNotice,
  skillInvocation,
  systemNoticeSummary,
  workerNotice,
} from "./notices.ts";

/**
 * The entries a client labels with their short id: the user's input, worker reports and updates, and replies with
 * text. Monchu's own notices, tool results and context markers stay unlabeled.
 */
export function addressable(entry: EntryRecord): boolean {
  const message = entry.model?.[0];
  if (entry.kind === "pi.user" && message?.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return systemNoticeSummary(text) === undefined;
  }
  return (
    entry.kind === "pi.assistant" &&
    message?.role === "assistant" &&
    message.content.some((part) => part.type === "text" && part.text.trim() !== "")
  );
}

/** When an addressable entry was sent: a reply when its request finished, input when it was accepted. */
export function sentAt(entry: EntryRecord): number | undefined {
  const message = entry.model?.[0];
  if (message?.role === "assistant") return message.timestamp + (message.durationMs ?? 0);
  return message?.role === "user" ? message.timestamp : undefined;
}

/**
 * Who sent an addressable entry and its text as clients show it, without the guidance Monchu adds for the model: a
 * worker's notice is its body, from the worker; a job's or another root's notice is its text, from `job <name>` or
 * `root <label>`; the user's input is what they typed (a skill as `/skill:<name>`, a reply without its quote) with its
 * files named; a reply is its text. In a root's front input is the user's and replies are Monchu's. In a worker's
 * conversation (`worker` names it) replies are the worker's, and input, which comes from Monchu, jobs, plugins or the
 * user, is `to <worker>`.
 */
export function messageOf(
  entry: EntryRecord,
  worker?: string,
): { from: string; text: string } | undefined {
  if (!addressable(entry)) return undefined;
  const notice = workerNotice(entry);
  if (notice !== undefined) return { from: notice.name, text: notice.text };
  const message = entry.model?.[0];
  if (message?.role === "assistant")
    return {
      from: worker ?? "monchu",
      text: message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim(),
    };
  if (message?.role !== "user") return undefined;
  const { text, files } = messageParts(message.content);
  const job = parseJobNotice(text);
  if (job !== undefined)
    return { from: `job ${job.name}`, text: `${job.header}\n${job.text}`.trim() };
  const root = parseRootNotice(text);
  if (root !== undefined) return { from: `root ${root.label}`, text: root.text };
  const skill = skillInvocation(text);
  const typed =
    skill === undefined
      ? (parseReply(text)?.text ?? text)
      : `/skill:${skill.name}${skill.text ? ` ${skill.text}` : ""}`;
  const named =
    files.length === 0 ? "" : `\n[attached: ${files.map((file) => file.name).join(", ")}]`;
  return { from: worker === undefined ? "you" : `to ${worker}`, text: `${typed.trim()}${named}` };
}
