/**
 * Release 3.0 lifecycle test: closing the desktop app before setup is finished must still reach the
 * runtime shutdown route (WAL checkpoint). Found by the clean-profile boot on 2026-10-13: the gate
 * answered 503 SETUP_REQUIRED and the shell had to kill the backend.
 */
import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { createInstallGateMiddleware } from "@/infrastructure/http/middleware/install.gate.middleware.js";

function run(path: string) {
  const gate = createInstallGateMiddleware(
    { findAnyCompleted: async () => null, findByTenant: async () => null } as never,
    { findAll: async () => [] } as never,
  );
  const next = vi.fn();
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) } as unknown as Response;
  return gate({ path } as Request, res, next).then(() => ({
    passed: next.mock.calls.length === 1,
    res,
  }));
}

describe("install gate before setup", () => {
  it("lets the desktop runtime routes through (they check their own token)", async () => {
    expect((await run("/api/desktop/runtime/shutdown")).passed).toBe(true);
    expect((await run("/api/desktop/runtime/pre-update-backup")).passed).toBe(true);
  });

  it("still blocks business routes", async () => {
    expect((await run("/api/invoices")).passed).toBe(false);
    expect((await run("/api/desktop/runtimeX")).passed).toBe(false);
  });
});
