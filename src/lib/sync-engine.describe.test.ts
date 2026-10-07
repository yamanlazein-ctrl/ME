import { describe, expect, it } from "vitest";
import { describeSyncProblem } from "./sync-engine";

describe("describeSyncProblem — no technical text reaches the operator", () => {
  it.each([
    ["hub accepted but not yet applied — retrying", "قيد المزامنة"],
    ["TypeError: fetch failed (ECONNREFUSED 10.0.0.1:443)", "لا يوجد اتصال"],
    ["HTTP 503 Service Unavailable", "لا يوجد اتصال"],
    ["SYNC_DEVICE_REVOKED", "معطَّل"],
    ["SYNC_UNKNOWN_DEVICE", "غير مسجّل"],
    ["401 Unauthorized", "انتهت جلسة"],
    ["409 version conflict on party", "تعارضت"],
    ['Failed query: insert into "rolls" values (?) — SQLITE_CONSTRAINT', "ستُعاد المحاولة"],
  ])("%s", (raw, expected) => {
    expect(describeSyncProblem(raw)).toContain(expected);
  });

  it("keeps a plain Arabic sentence and maps empty to null", () => {
    expect(describeSyncProblem("الفاتورة محفوظة.")).toBe("الفاتورة محفوظة.");
    expect(describeSyncProblem("")).toBeNull();
    expect(describeSyncProblem(null)).toBeNull();
  });
});
