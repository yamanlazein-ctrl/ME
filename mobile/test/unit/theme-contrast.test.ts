import { describe, expect, it } from "vitest";
import { themeColors, type ThemeName } from "../../src/ui/theme";

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe.each<ThemeName>(["dark", "light"])("%s theme contrast", (name) => {
  const c = themeColors(name);
  it.each([
    ["text on background", c.foreground, c.background],
    ["text on card", c.foreground, c.card],
    ["muted text on card", c.mutedForeground, c.card],
    ["muted text on background", c.mutedForeground, c.background],
    ["button text on primary", c.primaryForeground, c.primary],
    ["error text on card", c.negative, c.card],
    ["success text on card", c.positive, c.card],
    ["text on muted chip", c.foreground, c.muted],
  ])("%s ≥ 4.5:1", (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
  it("input borders are visible on cards (≥ 1.4:1)", () => {
    expect(contrast(c.input, c.card)).toBeGreaterThanOrEqual(1.4);
  });
});
