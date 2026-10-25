import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { ESLint } from "eslint";

const require = createRequire(import.meta.url);
const mobileRoot = path.resolve(__dirname, "../..");

describe("mobile import boundary", () => {
  it("ESLint rejects node:fs in app code with exactly one error", async () => {
    const eslint = new ESLint({ cwd: mobileRoot });
    const [result] = await eslint.lintText('import fs from "node:fs";\nexport const x = fs;\n', {
      filePath: path.join(mobileRoot, "src", "boundary-probe.ts"),
    });
    expect(result?.errorCount).toBe(1);
    expect(result?.messages[0]?.ruleId).toBe("no-restricted-imports");
  });

  it("Metro resolveRequest throws for pg and other banned modules", () => {
    const config = require(path.join(mobileRoot, "metro.config.js"));
    const resolve = config.resolver.resolveRequest as (c: unknown, m: string, p: string) => unknown;
    expect(() => resolve({}, "pg", "android")).toThrow("mobile import boundary: pg");
    expect(() => resolve({}, "node:fs", "android")).toThrow("mobile import boundary: node:fs");
    expect(() => resolve({}, "@sentry/node", "android")).toThrow("mobile import boundary");
  });

  it("maps the allowed built-ins to phone adapters", () => {
    const config = require(path.join(mobileRoot, "metro.config.js"));
    const resolve = config.resolver.resolveRequest as (
      c: unknown,
      m: string,
      p: string,
    ) => { filePath: string };
    expect(resolve({}, "node:crypto", "android").filePath).toMatch(/platform[\\/]nodeCrypto\.ts$/);
    expect(resolve({}, "node:async_hooks", "android").filePath).toMatch(/asyncContext\.ts$/);
    expect(resolve({}, "better-sqlite3", "android").filePath).toMatch(/BetterSqliteShim\.ts$/);
  });
});
