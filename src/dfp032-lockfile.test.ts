/**
 * DFP-032 — clean npm install policy is enforced in repo + CI.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

describe("DFP-032 lockfile / engines policy", () => {
  const root = resolve(process.cwd());

  it("package-lock.json exists and bun.lock does not", () => {
    expect(existsSync(resolve(root, "package-lock.json"))).toBe(true);
    expect(existsSync(resolve(root, "bun.lock"))).toBe(false);
    expect(existsSync(resolve(root, "bun.lockb"))).toBe(false);
  });

  it("package.json declares Node 22 engines and npm packageManager", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.engines?.node).toMatch(/22/);
    expect(String(pkg.packageManager ?? "")).toMatch(/^npm@/);
  });

  it(".gitignore ignores bun.lock", () => {
    const gi = readFileSync(resolve(root, ".gitignore"), "utf8");
    expect(gi).toMatch(/bun\.lock/);
  });

  it("CI uses Node 22 and npm ci (clean runner install)", () => {
    const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/node-version:\s*"22"/);
    expect(ci).toMatch(/npm ci/);
    expect(ci).not.toMatch(/node-version:\s*"20"/);
  });

  it("npm ci --dry-run succeeds against package-lock.json", () => {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const out = execFileSync(npmCmd, ["ci", "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      shell: process.platform === "win32",
    });
    expect(out.length).toBeGreaterThan(0);
  }, 120_000);
});
