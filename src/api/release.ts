/** What every client shows about the running release and updating it. Browser-safe. */

/** The core's release: its version, a newer edge build's commit, an update in progress, and the last update's outcome. */
export type Release = {
  version: string;
  /** The `edge` release's commit when it differs from this edge build's; a hint, never installed by itself. */
  available: string | null;
  /** The release `/update` is installing; the core goes away until it is back. */
  updating: string | null;
  /** How the update this process came back from went. */
  outcome: string | null;
};

/** `edge` or a version, without its `v`; `undefined` for anything else. */
export function parseRelease(text: string): string | undefined {
  return /^(edge|v?\d+\.\d+\.\d+[\w.-]*)$/.test(text) ? text.replace(/^v/, "") : undefined;
}

/** The notices a change of release state deserves; `previous` is undefined for the first state a client sees. */
export function releaseNotices(previous: Release | undefined, next: Release): string[] {
  const notices: string[] = [];
  if (previous !== undefined && previous.version !== next.version)
    notices.push(`monchu ${next.version} is running now`);
  if (next.outcome !== null && next.outcome !== previous?.outcome) notices.push(next.outcome);
  if (next.available !== null && next.available !== previous?.available)
    notices.push(`update available · edge ${next.available} · /update installs it`);
  return notices;
}
