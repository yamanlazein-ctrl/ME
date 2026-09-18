import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";

const BANNED = /admin123|Admin@12345/;
const FIXED_TENANT = /(?:407fccfc-ba89-41c5-b5b9-ddb2c4f385d9|ddb8adcd-fa06-4743-a8bb-9fb4e7a03691)/i;
const REUSABLE_DB_CREDENTIAL = /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (
      name === "node_modules" ||
      name === "test-results" ||
      name === "playwright-report" ||
      name === ".git" ||
      name === ".tmp" ||
      name === ".tmp-pgdata-dfp"
    ) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|md)$/.test(extname(p)) || name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

describe("DFP-029 credential hygiene", () => {
  it("seed-test-admin refuses outside test mode and requires E2E_ADMIN_PASSWORD", () => {
    const src = readFileSync(
      resolve(process.cwd(), "backend/seed-test-admin.mjs"),
      "utf8",
    );
    expect(src).toMatch(/ALLOW_TEST_SEED/);
    expect(src).toMatch(/E2E_ADMIN_PASSWORD/);
    expect(src).not.toMatch(/hash\("admin123"\)/);
  });

  it("README does not embed admin123 password", () => {
    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    expect(readme).not.toMatch(/admin123/);
    expect(readme).toMatch(/E2E_ADMIN_PASSWORD/);
  });

  it("testCredentials helper rejects missing password", async () => {
    const prev = process.env.E2E_ADMIN_PASSWORD;
    const prevNode = process.env.NODE_ENV;
    delete process.env.E2E_ADMIN_PASSWORD;
    process.env.NODE_ENV = "test";
    const { e2eAdminAuth } = await import("../tests/e2e/_helpers/testCredentials.ts");
    expect(() => e2eAdminAuth()).toThrow(/E2E_ADMIN_PASSWORD/);
    if (prev !== undefined) process.env.E2E_ADMIN_PASSWORD = prev;
    else delete process.env.E2E_ADMIN_PASSWORD;
    process.env.NODE_ENV = prevNode;
  });

  it("deployable/source tree has no reusable credentials or fixed tenants", () => {
    const hits: string[] = [];
    const roots = [
      resolve(process.cwd(), "backend/src"),
      resolve(process.cwd(), "scripts"),
      resolve(process.cwd(), "tests/e2e"),
    ];
    for (const root of roots) {
      for (const file of walk(root)) {
        if (file.endsWith("dfp029-credentials.test.ts")) continue;
      const src = readFileSync(file, "utf8");
        if (BANNED.test(src) || FIXED_TENANT.test(src) || REUSABLE_DB_CREDENTIAL.test(src)) {
          hits.push(file.replace(process.cwd() + "\\", "").replace(process.cwd() + "/", ""));
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
