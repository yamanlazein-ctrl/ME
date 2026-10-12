/**
 * Test-harness process lifecycle (CODEBASE_AUDIT_REPORT M-11). A server started as
 * `node tsx/cli.mjs server.ts` or through a shell is a WRAPPER: the real server is its child, so
 * killing the wrapper leaves an orphan holding the port, and a "restarted" server dies with
 * EADDRINUSE while health probes keep answering from the old one.
 */
import { execSync } from "node:child_process";

/** Spawn option: own process group on POSIX, so the whole tree can be signalled at once. */
export const TREE_SPAWN = { detached: process.platform !== "win32" };

/** Kill a spawned wrapper and every process under it. */
export function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32")
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL"); // negative pid = the TREE_SPAWN process group
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Resolve once nothing answers on the port any more (or throw after timeoutMs). */
export async function waitPortFree(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health/live`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`port ${port} still answering ${timeoutMs} ms after its server was killed`);
}
