import { describe, it, expect } from "vitest";
import { isHubOnlyPurgeError } from "./dyePurgeClient";

describe("isHubOnlyPurgeError", () => {
  it("matches the server's hub-only refusals", () => {
    expect(
      isHubOnlyPurgeError(
        new Error("الحذف التصحيحي يمسح فواتير وقيوداً مالية ولا يُزامَن، فيُبقي الأجهزة"),
      ),
    ).toBe(true);
    expect(
      isHubOnlyPurgeError(
        new Error("تعذّر التحقق من حالة تسجيل أجهزة المزامنة، والعملية لا تُزامَن"),
      ),
    ).toBe(true);
  });
  it("ignores other errors", () => {
    expect(isHubOnlyPurgeError(new Error("تعذّر إتمام الحذف التصحيحي"))).toBe(false);
    expect(isHubOnlyPurgeError("x")).toBe(false);
  });
});
