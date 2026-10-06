/**
 * The desktop process guards must CONTAIN an uncaught fault, not swallow the
 * process with it.
 *
 * Asserted against a real child process on purpose: what actually matters is
 * whether the process is still alive and still executing afterwards, and only a
 * child can answer that. An in-process assertion would keep passing even if the
 * shipped behaviour (Node's default `uncaughtException` handler, which exits)
 * broke.
 *
 * Each fault is raised from a callback, which is the shape these really take in
 * the server: a throwing 'error' event on a stream, or a rejected promise
 * nobody awaited. A throw unwinds its own task only — so a later checkpoint
 * running at all is the proof that the process survived.
 *
 * The child body is generated because the guard module sits outside a
 * test-scope specifier; it is emitted as a real file with a static import so
 * the child resolves the module the same way the bundled server does.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const guardUrl = pathToFileURL(
  path.join(here, "..", "src", "infrastructure", "config", "processGuard.ts"),
).href;

type ChildResult = { alive: boolean; stdout: string; stderr: string };

/** Run `body` in a child that has installed the guards, and report what survived. */
function runGuarded(body: string, install = "installProcessGuards();"): ChildResult {
  const dir = mkdtempSync(path.join(tmpdir(), "motard-guard-"));
  const script = path.join(dir, "child.mts");
  try {
    writeFileSync(
      script,
      `import { installProcessGuards, markServing, MAX_TOLERATED_CRASHES } from ${JSON.stringify(guardUrl)};
const { EventEmitter } = await import("node:events");
${install}
${body}
`,
    );
    // spawnSync, not execFileSync: a surviving child still has to hand back its
    // stderr, which is where the guard mirrors every fault.
    const r = spawnSync(process.execPath, ["--import", "tsx", script], {
      encoding: "utf8",
      timeout: 60_000,
    });
    return { alive: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stream 'error' with no listener is thrown by EventEmitter — the exact
 *  fault shape that used to take the whole desktop backend down. */
const STREAM_FAULT = `setImmediate(() => {
  new EventEmitter().emit("error", new Error("stream blew up"));
});`;

/** Two checkpoints: the first lets the fault run, the second proves the process
 *  is still executing afterwards. */
const AFTER_FAULT = `await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));`;

describe("desktop process guards", () => {
  it("keeps the process alive through an uncaught exception", () => {
    const r = runGuarded(`
      ${STREAM_FAULT}
      ${AFTER_FAULT}
      console.log("SURVIVED_EXCEPTION");
    `);
    expect(r.alive).toBe(true);
    expect(r.stdout).toContain("SURVIVED_EXCEPTION");
  });

  it("keeps the process alive through an unhandled rejection", () => {
    const r = runGuarded(`
      void Promise.reject(new Error("nobody awaited me"));
      ${AFTER_FAULT}
      console.log("SURVIVED_REJECTION");
    `);
    expect(r.alive).toBe(true);
    expect(r.stdout).toContain("SURVIVED_REJECTION");
  });

  it("mirrors the fault into server.log, which is all the shell can read", () => {
    // The structured log travels through pino's worker thread and is lost the
    // instant the process ends; the desktop shell only ever shows server.log.
    const r = runGuarded(`
      ${STREAM_FAULT}
      ${AFTER_FAULT}
      console.log("DONE");
    `);
    expect(r.alive).toBe(true);
    expect(r.stderr).toContain("[FATAL] Uncaught exception");
    expect(r.stderr).toContain("stream blew up");
  });

  it("gives up once the fault budget is spent, so a broken process is recycled", () => {
    // Without this bound a genuinely broken process would limp forever and the
    // supervisor would never get a clean one to restart.
    const r = runGuarded(`
      for (let i = 0; i < MAX_TOLERATED_CRASHES + 2; i++) {
        const n = i;
        setImmediate(() => {
          new EventEmitter().emit("error", new Error("fault " + n));
        });
        ${AFTER_FAULT}
      }
      console.log("SURVIVED_EVERYTHING");
    `);
    expect(r.alive).toBe(false);
    expect(r.stdout).not.toContain("SURVIVED_EVERYTHING");
    expect(r.stderr).toContain("budget exhausted");
  });

  it("counts a fault once even if the guards are installed twice", () => {
    // A double install must not consume the whole budget on the first fault —
    // that would turn a live server into an exiting one.
    const r = runGuarded(`
      installProcessGuards();
      ${STREAM_FAULT}
      ${AFTER_FAULT}
      console.log("SURVIVED_IDEMPOTENT");
    `);
    expect(r.alive).toBe(true);
    expect(r.stdout).toContain("SURVIVED_IDEMPOTENT");
    expect(r.stderr).not.toContain("budget exhausted");
  });

  it("a fault before the server is listening is a start-up failure, not a silent live process", () => {
    // The cloud hub used to stay alive with no port: a throw while building the
    // container was contained, so listen() never ran and nothing said why.
    const r = runGuarded(
      `
      ${STREAM_FAULT}
      ${AFTER_FAULT}
      console.log("SHOULD_NOT_RUN");
    `,
      "installProcessGuards({ fatalUntilServing: true });",
    );
    expect(r.alive).toBe(false);
    expect(r.stdout).not.toContain("SHOULD_NOT_RUN");
    expect(r.stderr).toContain("[FATAL] Server startup failed");
    expect(r.stderr).toContain("stream blew up");
  });

  it("once serving, the same fault is contained exactly as before", () => {
    const r = runGuarded(
      `
      markServing();
      ${STREAM_FAULT}
      ${AFTER_FAULT}
      console.log("SURVIVED_AFTER_LISTEN");
    `,
      "installProcessGuards({ fatalUntilServing: true });",
    );
    expect(r.alive).toBe(true);
    expect(r.stdout).toContain("SURVIVED_AFTER_LISTEN");
  });
});
