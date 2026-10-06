import { describe, expect, it } from "vitest";
import { isDesktopShellPath } from "./desktop-entry-path";

describe("desktop entry path", () => {
  it("treats the Tauri shell file as the app root", () => {
    expect(isDesktopShellPath("/_shell.html")).toBe(true);
    expect(isDesktopShellPath("/index.html")).toBe(true);
    expect(isDesktopShellPath("/")).toBe(false);
    expect(isDesktopShellPath("/customers")).toBe(false);
  });
});
