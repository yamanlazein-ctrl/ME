import { describe, expect, it, vi } from "vitest";
import { assertRtl } from "../../src/ui/rtl";

describe("rtl", () => {
  it("passes when I18nManager.isRTL is true (the stub is RTL)", () => {
    expect(assertRtl()).toBe(true);
  });
  it("logs an error otherwise", async () => {
    const rn = await import("react-native");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    (rn.I18nManager as { isRTL: boolean }).isRTL = false;
    expect(assertRtl()).toBe(false);
    expect(spy).toHaveBeenCalled();
    (rn.I18nManager as { isRTL: boolean }).isRTL = true;
    spy.mockRestore();
  });
});
