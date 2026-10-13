import { describe, it, expect } from "vitest";
import { resultErrorMessage } from "./resultErrorMessage";

describe("resultErrorMessage", () => {
  it("message plus the first field detail", () => {
    expect(
      resultErrorMessage({ message: "تحقق", details: { qty: ["أكبر من المتاح"] } }, "فشل"),
    ).toBe("تحقق — أكبر من المتاح");
  });
  it("never 'undefined — …' nor '[object Object]'", () => {
    expect(resultErrorMessage({ details: { qty: ["x"] } }, "فشل")).toBe("فشل — x");
    expect(resultErrorMessage({}, "فشل")).toBe("فشل");
    expect(resultErrorMessage({ message: "" }, "فشل")).toBe("فشل");
  });
  it("strings, Error objects and nothing", () => {
    expect(resultErrorMessage("مرفوض", "فشل")).toBe("مرفوض");
    expect(resultErrorMessage(new Error("انقطاع"), "فشل")).toBe("انقطاع");
    expect(resultErrorMessage(undefined, "فشل")).toBe("فشل");
    expect(resultErrorMessage(null, "فشل")).toBe("فشل");
  });
});
