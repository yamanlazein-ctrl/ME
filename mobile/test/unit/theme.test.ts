import { describe, expect, it } from "vitest";
import { colors, fontSize, spacing, TOUCH_TARGET } from "../../src/ui/theme";

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

  it("copies the desktop's light-theme tokens", () => {
    expect(colors.background).toBe("#f7f8fa");
    expect(colors.primary).toBe("#c89100");
    expect(colors.foreground).toBe("#1e293b");
  });

  it("text colours meet WCAG AA (4.5:1) on the light surfaces", () => {
    for (const [fg, bg] of [
      [colors.foreground, colors.background],
      [colors.foreground, colors.card],
      [colors.mutedForeground, colors.background],
      [colors.negative, colors.card],
      [colors.positive, colors.card],
      [colors.currencySyp, colors.card],
      [colors.currencyUsd, colors.card],
      [colors.primaryForeground, "#8a6200"],
    ] as const) {
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
