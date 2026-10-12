/**
 * CODEBASE_AUDIT_REPORT_hermes C1-05 / C1-06 / C1-19 + the party-balance error state.
 * Source contracts (the route components are not renderable in this node test environment).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { roleCanAccess } from "@/presentation/hooks/useSettings";

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

describe("reports", () => {
  it("C1-05: every report the detail page implements has a tile on /reports", () => {
    const detail = read("reports.$slug.tsx");
    const implemented = [...detail.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]);
    const tiles = [...read("reports.index.tsx").matchAll(/\["([a-z-]+)", "[^"]+"\]/g)].map(
      (m) => m[1],
    );
    expect(implemented.length).toBeGreaterThan(5);
    expect(implemented.filter((s) => !tiles.includes(s))).toEqual([]);
  });

  it("C1-06 + D-3: party balances rank USD debtors too and show a failed load as an error, not 'no data'", () => {
    const body = read("reports.$slug.tsx")
      .split("function PartyBalances")[1]
      .split("\nfunction ")[0];
    expect(body).toMatch(/remaining\.SYP[\s\S]*\|\|[\s\S]*remaining\.USD/);
    expect(body).toContain("setFailed(true)");
    expect(body).toContain('role="alert"');
  });
});

describe("C1-19: nav while the role is unknown", () => {
  it("AppShell falls back to the viewer's paths, never to every group", () => {
    const src = readFileSync(join(__dirname, "../components/layout/AppShell.tsx"), "utf8");
    expect(src).toMatch(/\?\? "viewer"/);
    expect(src).not.toMatch(/:\s*GROUPS;/);
    expect(roleCanAccess("viewer", "/settings/users")).toBe(false);
  });
});
