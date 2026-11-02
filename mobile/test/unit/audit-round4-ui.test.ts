/**
 * Round-4 UI audit (phone): actions that failed silently and rows that looked tappable but did nothing.
 */
import { describe, expect, it, vi } from "vitest";

const app: { phone: unknown } = { phone: null };
vi.mock("../../src/core/appRuntime", () => ({ getApp: async () => app }));
vi.mock("../../src/core/devlog", () => ({ logError: vi.fn() }));

const { runPhoneAction, NO_PHONE_MESSAGE } = await import("../../src/core/phoneAction");
const { entryOpens } = await import("../../src/ui/PartyViews");

describe("runPhoneAction (P6–P8: no silent failure)", () => {
  it("says so when the phone is not ready, instead of returning silently", async () => {
    const errors: Array<string | null> = [];
    app.phone = null;
    expect(
      await runPhoneAction(
        "t",
        async () => 1,
        (m) => errors.push(m),
      ),
    ).toBeUndefined();
    expect(errors.at(-1)).toBe(NO_PHONE_MESSAGE);
  });
  it("a thrown error becomes a message: Arabic as is, anything else as a plain sentence", async () => {
    app.phone = {};
    const errors: Array<string | null> = [];
    await runPhoneAction(
      "t",
      async () => {
        throw new Error("اليوم مقفل");
      },
      (m) => errors.push(m),
    );
    expect(errors.at(-1)).toBe("اليوم مقفل");
    await runPhoneAction(
      "t",
      async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      (m) => errors.push(m),
    );
    expect(errors.at(-1)).toBe("تعذّر إتمام العملية. حاول مرة أخرى.");
    expect(
      await runPhoneAction(
        "t",
        async () => 7,
        (m) => errors.push(m),
      ),
    ).toBe(7);
    expect(errors.at(-1)).toBeNull();
  });
});

describe("statement rows open only what has a page (P10)", () => {
  const row = (type: string, status = "active") => ({ type, status, referenceId: "r1" }) as never;
  it("invoices for everyone; receipts and payments for writers; returns and expenses never", () => {
    expect(entryOpens(row("sales_invoice"))).toBe(true);
    expect(entryOpens(row("receipt_in"))).toBe(false);
    expect(entryOpens(row("receipt_in"), true)).toBe(true);
    expect(entryOpens(row("sales_return"), true)).toBe(false);
    expect(entryOpens(row("expense"), true)).toBe(false);
    expect(entryOpens(row("sales_invoice", "cancelled"), true)).toBe(false);
  });
});
