// Every CI build gets a higher Android version, so a new APK installs over the installed one and keeps its data.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve(__dirname, "../../../scripts/android/set-version.mjs");
const appJson = path.resolve(__dirname, "../../app.json");

function versionFor(run: string) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "ver-")), "app.json");
  copyFileSync(appJson, file);
  execFileSync(process.execPath, [script, file, run]);
  return JSON.parse(readFileSync(file, "utf8")).expo as {
    version: string;
    android: { versionCode: number; package: string };
  };
}

describe("CI build version", () => {
  it("rises with the run number and keeps the rest of the Android config", () => {
    const a = versionFor("63");
    const b = versionFor("64");
    expect(a.version).toBe("1.1.63");
    expect(a.android.versionCode).toBe(163);
    expect(b.android.versionCode).toBeGreaterThan(a.android.versionCode);
    expect(a.android.package).toBe("com.motard.erp");
    // Higher than every APK handed out before (all were versionCode 1).
    expect(a.android.versionCode).toBeGreaterThan(1);
  });

  it("refuses a missing or bad run number instead of building an unversioned APK", () => {
    expect(() => versionFor("0")).toThrow();
    expect(() => versionFor("abc")).toThrow();
  });
});
