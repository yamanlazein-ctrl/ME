import { describe, it, expect } from "vitest";
import {
  isValidHexColor,
  safeHexColor,
  hexToRgbSafe,
  COLOR_NEUTRAL_FALLBACK,
  COLOR_PICKER_FALLBACK,
} from "../color";

describe("safe color helpers", () => {
  it("never returns the input colour when invalid (no crash)", () => {
    expect(safeHexColor("jkjlj")).toBe(COLOR_NEUTRAL_FALLBACK);
    expect(safeHexColor(77777)).toBe(COLOR_NEUTRAL_FALLBACK);
    expect(safeHexColor("9999999")).toBe(COLOR_NEUTRAL_FALLBACK);
    expect(safeHexColor(null)).toBe(COLOR_NEUTRAL_FALLBACK);
    expect(safeHexColor(undefined)).toBe(COLOR_NEUTRAL_FALLBACK);
    expect(safeHexColor({ r: 1 })).toBe(COLOR_NEUTRAL_FALLBACK);
  });

  it("accepts and normalizes valid hex values", () => {
    expect(safeHexColor("#FFFFFF")).toBe("#ffffff");
    expect(safeHexColor("#fff")).toBe("#fff");
    expect(safeHexColor("FF0000")).toBe("#ff0000");
    expect(safeHexColor("#000000")).toBe("#000000");
  });

  it("validates with isValidHexColor", () => {
    expect(isValidHexColor("#abc123")).toBe(true);
    expect(isValidHexColor("abc")).toBe(true);
    expect(isValidHexColor("#gggggg")).toBe(false);
    expect(isValidHexColor("not-a-color")).toBe(false);
    expect(isValidHexColor(123)).toBe(false);
    expect(isValidHexColor(null)).toBe(false);
  });

  it("hexToRgbSafe converts valid hex and degrades safely", () => {
    expect(hexToRgbSafe("#000000")).toBe("rgb(0 0 0)");
    expect(hexToRgbSafe("#ffffff")).toBe("rgb(255 255 255)");
    expect(hexToRgbSafe("jkjlj")).toBe("rgb(209 213 219)");
    expect(hexToRgbSafe(null)).toBe("rgb(209 213 219)");
  });

  it("picker fallback is a 6-digit valid hex", () => {
    expect(isValidHexColor(COLOR_PICKER_FALLBACK)).toBe(true);
    expect(COLOR_PICKER_FALLBACK).toBe("#000000");
  });
});
