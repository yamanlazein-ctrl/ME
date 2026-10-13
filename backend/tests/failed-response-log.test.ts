/**
 * aduite-12 #9 — a refused or failed request is logged with its outcome (status, API error code,
 * message), never with the request body.
 */
import { describe, it, expect, vi } from "vitest";
import type { AddressInfo } from "node:net";
import express from "express";
import { logger } from "@/infrastructure/config/logger.js";
import { logFailedResponses } from "@/infrastructure/http/middleware/failed-response-log.middleware.js";

describe("failed response logging", () => {
  it("logs 4xx as warn and 5xx as error with code/message, not the body; 2xx not at all", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const app = express();
    app.use(express.json());
    app.use(logFailedResponses);
    app.post("/r", (_q, r) => void r.status(422).json({ code: "VALIDATION", message: "مرفوض" }));
    app.post("/f", (_q, r) => void r.status(500).json({ code: "INTERNAL", message: "x" }));
    app.post("/ok", (_q, r) => void r.json({ ok: true }));
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const send = (p: string) =>
      fetch(base + p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret-1234" }),
      });
    try {
      await send("/r");
      await send("/f");
      await send("/ok");
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    const refused = warn.mock.calls.find((c) => c[1] === "Request refused")?.[0] as Record<
      string,
      unknown
    >;
    expect(refused).toMatchObject({
      status: 422,
      code: "VALIDATION",
      message: "مرفوض",
      path: "/r",
    });
    expect(error.mock.calls.some((c) => (c[0] as { status?: number }).status === 500)).toBe(true);
    const all = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(all).not.toContain("secret-1234");
    expect(all).not.toContain('"/ok"');
    warn.mockRestore();
    error.mockRestore();
  });
});
