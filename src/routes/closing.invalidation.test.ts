/**
 * CODEBASE_AUDIT_REPORT_hermes F-019 — year close / reopen must refresh every financial view through
 * the central helper (CLAUDE.md rule), not three ad-hoc keys. Source contract: the route component
 * is not renderable in this node test environment.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "closing.tsx"), "utf8");

describe("closing.tsx cache refresh", () => {
  it("refreshAll() calls invalidateFinancialViews, and both mutations use refreshAll", () => {
    const body = /const refreshAll = \(\) => \{([\s\S]*?)\n {2}\};/.exec(src)?.[1] ?? "";
    expect(body).toContain("invalidateFinancialViews(qc)");
    expect(src.match(/onSuccess:[\s\S]*?refreshAll\(\);/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
