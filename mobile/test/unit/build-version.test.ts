// Every build of a later commit gets a higher Android version, so a new APK installs over the installed one and keeps
// its data (Android refuses a lower version).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildNumber, withBuildVersion } = require("../../scripts/build-version.cjs") as {
  buildNumber(cwd: string, env?: Record<string, string | undefined>): number;
  withBuildVersion(
    config: { version: string; android: Record<string, unknown> },
    n: number,
  ): { version: string; android: { versionCode?: number; package?: string } };
};

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repoWithCommits(n: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ver-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
  git("init", "-q");
  for (let i = 0; i < n; i++) {
    writeFileSync(path.join(dir, "f"), String(i));
    git("add", "f");
    git("commit", "-q", "-m", `c${i}`);
  }
  return dir;
}

const base = { version: "1.0.0", android: { package: "com.motard.erp", versionCode: 1 } };

describe("build version", () => {
  it("is the commit count: a later commit is a higher version", () => {
    expect(buildNumber(repoWithCommits(3), {})).toBe(3);
    expect(buildNumber(repoWithCommits(5), {})).toBe(5);
  });

  it("versionCode 100 + build, version 1.1.<build>, the rest of the Android config kept", () => {
    const v = withBuildVersion(base, 183);
    expect(v.version).toBe("1.1.183");
    expect(v.android.versionCode).toBe(283);
    expect(v.android.package).toBe("com.motard.erp");
    // Higher than every APK handed out before (versionCode 1).
    expect(v.android.versionCode).toBeGreaterThan(1);
    expect(withBuildVersion(base, 0)).toBe(base);
  });

  it("an explicit build number wins; a bad one is refused rather than building an unversioned APK", () => {
    expect(buildNumber(repoWithCommits(2), { MOTARD_BUILD_NUMBER: "400" })).toBe(400);
    expect(() => buildNumber(repoWithCommits(2), { MOTARD_BUILD_NUMBER: "x" })).toThrow();
  });

  it("no git history: app.json's version is kept", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ver-"));
    dirs.push(dir);
    expect(buildNumber(dir, {})).toBe(0);
  });
});
