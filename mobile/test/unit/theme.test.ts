import { describe, expect, it } from "vitest";
import { fontSize, spacing, themeColors, TOUCH_TARGET } from "../../src/ui/theme";

const light = themeColors("light");
const dark = themeColors("dark");

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("theme tokens", () => {
  it("body text is at least 16 sp and touch targets at least 48 dp (UX-06, NFR-09)", () => {
    expect(fontSize.body).toBeGreaterThanOrEqual(16);
    expect(fontSize.input).toBeGreaterThanOrEqual(16);
    expect(fontSize.caption).toBeGreaterThanOrEqual(16);
    expect(TOUCH_TARGET).toBeGreaterThanOrEqual(48);
  });

  it("uses the spacing scale 4/8/12/16/24/32", () => {
    expect(Object.values(spacing).filter((v) => [4, 8, 12, 16, 24, 32].includes(v))).toHaveLength(
      6,
    );
  });

  it("copies the desktop's tokens: dark is the default theme, light the soft theme", () => {
    expect(dark.background).toBe("#0a0a0a");
    expect(dark.primary).toBe("#ffd740");
    expect(dark.foreground).toBe("#fafafa");
    expect(light.background).toBe("#f7f8fa");
    expect(light.primary).toBe("#c89100");
    expect(light.foreground).toBe("#1e293b");
  });

  it("text colours meet WCAG AA (4.5:1) on the light surfaces", () => {
    for (const [fg, bg] of [
      [light.foreground, light.background],
      [light.foreground, light.card],
      [light.mutedForeground, light.background],
      [light.negative, light.card],
      [light.positive, light.card],
      [light.currencySyp, light.card],
      [light.currencyUsd, light.card],
      [light.primaryForeground, light.primary],
    ] as const) {
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("text colours meet WCAG AA (4.5:1) on the dark surfaces", () => {
    for (const [fg, bg] of [
      [dark.foreground, dark.background],
      [dark.foreground, dark.card],
      [dark.mutedForeground, dark.background],
      [dark.negative, dark.card],
      [dark.positive, dark.card],
      [dark.primary, dark.background],
      [dark.primaryForeground, dark.primary],
    ] as const) {
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
