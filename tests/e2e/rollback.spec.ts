import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import path from "path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

test.describe("Git Rollback Verification", () => {
  test("current HEAD is valid commit", () => {
    const hash = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
    expect(hash).toMatch(/^[a-f0-9]{40}$/);
  });

  test("npm run build succeeds", () => {
    const output = execSync("npm run build", { cwd: REPO_ROOT, encoding: "utf-8", timeout: 120000 });
    expect(output).toBeTruthy();
  });
});
