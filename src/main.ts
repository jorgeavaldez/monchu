import { join } from "node:path";
import { monchuHome } from "./home.ts";

try {
  const home = await monchuHome(process.env.MONCHU_DEV_FAUX === "1");
  // SDK modules capture some agent paths at import time. Never import them before this assignment.
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  // Inherited by /restart so smoke mode reopens the same isolated home.
  if (process.env.MONCHU_DEV_FAUX === "1") process.env.MONCHU_DEV_HOME = home;
  const { Monchu } = await import("./backend.ts");
  const { runTerminal } = await import("./tui/app.ts");
  const backend =
    process.env.MONCHU_DEV_FAUX === "1"
      ? await (await import("./dev-faux.ts")).openDevMonchu(home)
      : await Monchu.open(home);
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
