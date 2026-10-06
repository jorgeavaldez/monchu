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

// Storage is closed and accepted work stays recoverable. Anything still holding the event loop (a dependency's
// socket or timer) must not keep `/quit` hanging; the unref'd timer only fires if something does.
setTimeout(() => process.exit(), 1000).unref();
