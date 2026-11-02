/**
 * Sync audit (round 4) — guards for the parity defects fixed together:
 *  #9  a party's credit limit was never synced (snapshots omitted it, dependency stores hard-coded 0);
 *  #18 a dead hub unit pushed again was materialized after its claims were released;
 *  #19 an update of a cancelled invoice was retried 5 times ("failed") instead of refused ("conflict");
 *  #21 the roll-adjust replay fell back to the UTC date.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toPartySnapshot } from "../src/application/use-cases/sync/syncDependencySnapshots.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

describe("#9 party credit limit travels with the party", () => {
  it("the canonical snapshot carries creditLimit", () => {
    const snap = toPartySnapshot({
      id: "p1",
      kind: "customer",
      name: "x",
      currency: "USD",
      creditLimit: 5000,
    } as never);
    expect(snap.creditLimit).toBe(5000);
  });
  it("both dependency stores insert the snapshot's limit, not 0", () => {
    const stores = [
      read("src", "infrastructure", "repositories", "sqlite", "SqliteSyncDependencyStore.ts"),
      read("src", "infrastructure", "repositories", "PostgresSyncDependencyStore.ts"),
    ];
    for (const s of stores) {
      expect(s).toContain("creditLimit: Number(p.creditLimit ?? 0)");
      expect(s).not.toMatch(/creditLimit: 0,/);
    }
  });
  it("the desktop route and the phone send it on party create", () => {
    expect(read("src", "presentation", "routes", "party.route.ts")).toContain(
      "creditLimit: p.creditLimit ?? 0",
    );
    expect(
      readFileSync(join(ROOT, "..", "mobile", "src", "core", "documents.ts"), "utf8"),
    ).toContain("creditLimit: p.creditLimit ?? 0");
  });
});

describe("#18, #19, #21 hub replay", () => {
  const uc = read("src", "application", "use-cases", "sync", "syncUseCases.ts");
  const mat = read("src", "application", "use-cases", "sync", "syncMaterialize.ts");
  it("a dead inbox unit pushed again returns before any materialization", () => {
    const dead = uc.indexOf('if (existing.row.status === "dead")');
    const retry = uc.indexOf("const mat = await tryMaterializeAcceptedUnit(");
    expect(dead).toBeGreaterThan(0);
    expect(dead).toBeLessThan(retry);
  });
  it("updating a cancelled invoice is a conflict, not a retryable failure", () => {
    expect(mat).toMatch(/status: "conflict", error: "لا يمكن تعديل فاتورة ملغاة"/);
  });
  it("the roll-adjust replay falls back to the local date", () => {
    expect(mat).not.toContain("payload.date ?? new Date().toISOString().slice(0, 10)");
    expect(mat).toContain("payload.date ?? localToday()");
  });
});
