import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { planBulkDelete, type BulkItem } from "./bulkDelete";

// colour c1 and c2 belong to fabric f1; roll r1 is in c1, r2 in c3 (fabric f2), r3 is unknown.
const colorFabric: Record<string, string> = { c1: "f1", c2: "f1", c3: "f2" };
const rollColor: Record<string, string> = { r1: "c1", r2: "c3" };
const lookup = {
  colorFabricId: (id: string) => colorFabric[id],
  rollColorId: (id: string) => rollColor[id],
};
const item = (kind: BulkItem["kind"], id: string): BulkItem => ({
  kind,
  id,
  name: `${kind}-${id}`,
});

describe("planBulkDelete", () => {
  it("queues every selected fabric for the confirmation dialog, in selection order", () => {
    const plan = planBulkDelete([item("fabric", "f2"), item("fabric", "f1")], lookup);
    expect(plan.fabrics).toEqual([
      { id: "f2", name: "fabric-f2" },
      { id: "f1", name: "fabric-f1" },
    ]);
    expect(plan.colorIds).toEqual([]);
    expect(plan.rollIds).toEqual([]);
  });

  it("skips colours and rolls that a selected fabric or colour already covers", () => {
    const plan = planBulkDelete(
      [
        item("fabric", "f1"),
        item("color", "c1"), // covered by f1
        item("color", "c3"), // fabric f2 is not selected -> kept
        item("roll", "r1"), // covered by f1 (via c1)
        item("roll", "r2"), // covered by the selected colour c3
        item("roll", "r3"), // unknown roll -> kept (the server decides)
      ],
      lookup,
    );
    expect(plan.fabrics.map((f) => f.id)).toEqual(["f1"]);
    expect(plan.colorIds).toEqual(["c3"]);
    expect(plan.rollIds).toEqual(["r3"]);
  });

  it("handles an empty selection", () => {
    expect(planBulkDelete([], lookup)).toEqual({ fabrics: [], colorIds: [], rollIds: [] });
  });
});

describe("inventory page never purges a fabric by itself", () => {
  // BUG-003: the bulk path used to call purgeDye(id, CONFIRM_WORD) directly, skipping the impact
  // sheet, the typed confirmation and the hub-only guidance of DyePurgeDialog.
  const src = readFileSync(new URL("../../routes/inventory.tsx", import.meta.url), "utf8");
  it("does not import the purge client or the confirmation word", () => {
    expect(src).not.toMatch(/\bpurgeDye\b/);
    expect(src).not.toMatch(/\bCONFIRM_WORD\b/);
  });
  it("hands fabrics to DyePurgeDialog", () => {
    expect(src).toMatch(/<DyePurgeDialog/);
    expect(src).toMatch(/planBulkDelete\(/);
  });
});
