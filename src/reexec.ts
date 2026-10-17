import { spawn } from "node:child_process";

/**
 * Re-execute Monchu with the same arguments, after /restart closed the core; never resolves. Process state belongs to
 * the entry point: only `src/main.ts` calls this.
 */
export function reexecute(): Promise<never> {
  process.stdin.pause();
  const argv = [...process.execArgv, ...process.argv.slice(1)];
  // Replacing the process keeps one Monchu per terminal however often it restarts; spawning leaves each old process
  // waiting on its child, and Android kills Termux once too many pile up. Windows has no execve: Node defines it there
  // but it throws.
  if (process.platform !== "win32" && typeof process.execve === "function")
    process.execve(process.execPath, [process.execPath, ...argv]);
  return new Promise<never>((_resolve, reject) => {
    const child = spawn(process.execPath, argv, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });
  });
}
