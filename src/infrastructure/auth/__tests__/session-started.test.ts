/**
 * Customers, suppliers and rolls live in module caches that load once at
 * startup. A PIN login AFTER startup left them empty (everything "gone" while
 * the dashboard still showed figures). persistTokens now announces a NEW
 * session so those caches reload — but not on routine token refreshes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

describe("persistTokens → session-started event", () => {
  let events: string[];
  beforeEach(() => {
    events = [];
    const target = new EventTarget();
    target.addEventListener("erp:session-started", () => events.push("started"));
    vi.stubGlobal("localStorage", new MemStorage());
    vi.stubGlobal("window", Object.assign(target, { localStorage: globalThis.localStorage }));
  });

  it("fires on a new login and not on a token refresh", async () => {
    const { persistTokens, clearTokens, SESSION_STARTED_EVENT } = await import("../TokenProvider");
    expect(SESSION_STARTED_EVENT).toBe("erp:session-started");
    persistTokens("access-1", "refresh-1"); // PIN login after startup
    expect(events).toEqual(["started"]);
    persistTokens("access-2", "refresh-2"); // refresh of the same session
    expect(events).toEqual(["started"]);
    clearTokens(); // logout
    persistTokens("access-3"); // next user logs in
    expect(events).toEqual(["started", "started"]);
  });
});
