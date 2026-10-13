/**
 * VERIFIED_REMEDIATION_PLAN ERP-005 — the passwordless owner console ("open loopback") must not be
 * reachable THROUGH a local proxy: the admin-dashboard dev proxy connects from loopback, so a remote
 * client behind it used to be granted super_admin without any credential.
 */
import { describe, it, expect, vi } from "vitest";
import { createSuperAdminAuthMiddleware } from "@/infrastructure/http/middleware/super-admin-auth.middleware.js";

function run(socket: string, headers: Record<string, string> = {}, ip = socket) {
  const mw = createSuperAdminAuthMiddleware({} as never, {} as never, { openLoopback: true });
  const req = { ip, socket: { remoteAddress: socket }, headers } as never;
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) } as never;
  const next = vi.fn();
  return mw(req, res, next).then(() => next.mock.calls.length === 1);
}

describe("super-admin open loopback", () => {
  it("a caller on this machine is let in", async () => {
    expect(await run("127.0.0.1")).toBe(true);
    expect(await run("::ffff:127.0.0.1", { "x-forwarded-for": "127.0.0.1" })).toBe(true);
  });

  it("a remote client forwarded by a local proxy is refused", async () => {
    expect(await run("127.0.0.1", { "x-forwarded-for": "192.168.1.50" })).toBe(false);
    expect(await run("127.0.0.1", { "x-forwarded-for": "127.0.0.1, 10.0.0.9" })).toBe(false);
    expect(await run("127.0.0.1", { forwarded: 'for="[2001:db8::1]"' })).toBe(false);
  });

  it("a remote socket is refused even if req.ip claims loopback", async () => {
    expect(await run("192.168.1.50", {}, "127.0.0.1")).toBe(false);
  });
});
