import { describe, expect, it, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pino from "pino";
import { createErrorHandler } from "../src/infrastructure/http/middleware/error-handler.middleware.js";

/**
 * Regression test for the Phase 1 foundation audit (F13 cluster): the
 * License Server entrypoint (backend/src/scripts/license-server.ts) never
 * registered `createErrorHandler` as its last middleware, so any thrown/
 * `next(err)`'d error — including the "license server lists licenses"
 * failure on an empty database — fell through to Express's *default* error
 * handler and returned an HTML page. The acceptance health check parses the
 * response as `{licenses:[...]}`, so `body.licenses.length` read as
 * `undefined` — the reported "500 count=undefined" symptom was really "the
 * error response wasn't JSON at all", independent of whatever originally
 * threw.
 *
 * This test mirrors the exact shape now wired into license-server.ts: a
 * route that throws, forwarded via `next(err)`, with `createErrorHandler`
 * mounted last. Before the fix (no error handler registered), this would
 * fail: Express's default handler responds with `content-type: text/html`
 * and a stack-trace body, not `{code, message, statusCode}` JSON.
 */
const SERVERS_TO_CLOSE: Server[] = [];
afterEach(() => {
  while (SERVERS_TO_CLOSE.length) SERVERS_TO_CLOSE.pop()?.close();
});

describe("License Server — error responses are JSON (F13 regression)", () => {
  it("returns a JSON error body, not an HTML page, when a route handler throws", async () => {
    const app = express();
    app.get("/license-admin/licenses", (_req, _res, next) => {
      // Simulates any uncaught failure in the licenses-listing query path.
      next(new Error("simulated query failure"));
    });
    // Must be registered LAST, after all routes — same as license-server.ts.
    app.use(createErrorHandler(pino({ level: "silent" })));

    const server = app.listen(0);
    SERVERS_TO_CLOSE.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/license-admin/licenses`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);

    const body = (await res.json()) as { code: string; message: string; statusCode: number };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(typeof body.message).toBe("string");
  });

  it("without the error handler wired in, the same failure is NOT JSON (documents the pre-fix bug)", async () => {
    const app = express();
    app.get("/license-admin/licenses", (_req, _res, next) => {
      next(new Error("simulated query failure"));
    });
    // No createErrorHandler mounted — this is exactly the old license-server.ts.

    const server = app.listen(0);
    SERVERS_TO_CLOSE.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/license-admin/licenses`);
    expect(res.status).toBe(500);
    // Express's built-in default handler responds with HTML, not JSON —
    // this is the shape that made `body?.licenses?.length` read as
    // `undefined` in the acceptance script.
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});
