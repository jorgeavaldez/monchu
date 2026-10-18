/**
 * Start an installed release the way `/update` checks one before it replaces the running copy (`bootCheck`): CI runs it
 * on the packed tarball, installed as a user installs it, before edge or a version moves to that build.
 *
 *   mise run boot-check -- <the installed package's root>
 */
import { bootCheck } from "../src/core/update.ts";

const root = process.argv[2];
if (root === undefined)
  throw new Error("Usage: node scripts/boot-check.ts <installed package root>");
const result = await bootCheck(root);
if (!result.ok) {
  console.error(`${result.reason}:\n${result.tail.join("\n")}`);
  process.exit(1);
}
console.log(`${root} starts`);
