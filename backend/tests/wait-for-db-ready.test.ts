import { describe, it, expect, vi } from "vitest";
import {
  isTransientDbStartupError,
  waitForDatabaseReady,
} from "../src/infrastructure/orm/runDesktopMigrations.js";

function dbErr(code: string): Error & { code: string } {
  const e = new Error(`boom ${code}`) as Error & { code: string };
  e.code = code;
  return e;
}

describe("isTransientDbStartupError (PR-2 classification)", () => {
  it("classifies connect/startup/shutdown classes as transient", () => {
    for (const code of ["ECONNREFUSED", "57P03", "57P01", "08006", "53300"]) {
      expect(isTransientDbStartupError(dbErr(code))).toBe(true);
    }
  });

  it("treats a genuine schema/SQL error as fatal (never masked)", () => {
    expect(isTransientDbStartupError(dbErr("42P01"))).toBe(false); // undefined_table
    expect(isTransientDbStartupError(new Error("no code"))).toBe(false);
    expect(isTransientDbStartupError(null)).toBe(false);
  });
});

describe("waitForDatabaseReady (PR-2 bounded readiness gate)", () => {
  it("returns immediately when the probe succeeds", async () => {
    const probe = vi.fn(async () => 1);
    await expect(waitForDatabaseReady(probe, { sleep: async () => {} })).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retries only transient errors, with backoff, until the DB answers", async () => {
    let n = 0;
    const probe = vi.fn(async () => {
      if (++n < 3) throw dbErr("ECONNREFUSED");
      return 1;
    });
    const sleep = vi.fn(async () => {});
    await waitForDatabaseReady(probe, { sleep, attempts: 5 });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does NOT mask a real error — throws immediately", async () => {
    const probe = vi.fn(async () => {
      throw dbErr("42P01");
    });
    await expect(
      waitForDatabaseReady(probe, { sleep: async () => {}, attempts: 5 }),
    ).rejects.toMatchObject({ code: "42P01" });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("surfaces the last genuine DB error once the budget is exhausted", async () => {
    const probe = vi.fn(async () => {
      throw dbErr("57P03");
    });
    await expect(
      waitForDatabaseReady(probe, { sleep: async () => {}, attempts: 3 }),
    ).rejects.toMatchObject({ code: "57P03" });
    expect(probe).toHaveBeenCalledTimes(3);
  });
});