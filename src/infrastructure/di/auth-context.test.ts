import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTenantContext } from "./auth-context";

const storage = new Map<string, string>();

function installStorage() {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
}

afterEach(() => {
  storage.clear();
  vi.unstubAllGlobals();
});

describe("buildTenantContext", () => {
  it("reads the token when called, not when the module is imported", () => {
    installStorage();
    const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = (tenantId: string) =>
      `${header}.${btoa(JSON.stringify({ tenantId, sub: "user-1", role: "admin" }))}.signature`;

    expect(buildTenantContext().tenantId).toBe("dev-tenant");
    storage.set("erp.auth.accessToken", payload("tenant-after-login"));
    expect(buildTenantContext().tenantId).toBe("tenant-after-login");
  });
});
