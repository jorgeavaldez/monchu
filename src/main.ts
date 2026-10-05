import { Monchu } from "./backend.ts";
import { runTerminal } from "./terminal.ts";

try {
  const backend = await Monchu.open();
  try {
    await runTerminal(backend);
  } finally {
    await backend.close();
  }
} catch (error) {
  console.error(`system · error · ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
