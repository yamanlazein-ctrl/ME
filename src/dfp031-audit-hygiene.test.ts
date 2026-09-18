/**
 * DFP-031 — certification suites must not soft-pass or encode known failures.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("DFP-031 audit soft-pass hygiene", () => {
  it("cert-ui specs have no || true soft passes", () => {
    const dir = resolve(process.cwd(), "tests/e2e/cert-ui");
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const code = stripComments(readFileSync(join(dir, name), "utf8"));
      expect(code, name).not.toMatch(/\|\|\s*true\b/);
    }
  });

  it("audit-findings has no active it.fails defect encodings", () => {
    const code = stripComments(
      readFileSync(resolve(process.cwd(), "backend/tests/audit-findings.test.ts"), "utf8"),
    );
    expect(code).not.toMatch(/\bit\.fails\s*\(/);
  });
});
