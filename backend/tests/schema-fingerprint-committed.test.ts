/**
 * Phase 0.1 guard — the committed schema fingerprint must be REAL.
 *
 * Why this test exists: `schema-fingerprint.json` shipped as
 * `"sha256": "pending-generate"` with empty maps. `loadCommittedFingerprint()`
 * then returns `null` for it (schemaFingerprint.ts), which makes
 * `runDesktopMigrations` throw `SCHEMA_UNVERIFIED` and the desktop app REFUSE
 * TO BOOT for any pre-drizzle cluster. Nothing failed at the time — the
 * placeholder looked like a normal committed file.
 *
 * This test fails the build the moment the fingerprint regresses to a
 * placeholder, which is the only thing that keeps Phase 0.1 from silently
 * un-doing itself on the next schema change.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCommittedFingerprint } from "@/infrastructure/orm/schemaFingerprint.js";

const META = join(
  process.cwd(),
  "src",
  "infrastructure",
  "orm",
  "migrations",
  "meta",
  "schema-fingerprint.json",
);

const raw = JSON.parse(readFileSync(META, "utf8")) as {
  sha256: string;
  journalIdx: number;
  tables: Record<string, unknown>;
  indexes: Record<string, unknown>;
  policies: Record<string, unknown>;
  triggers: Record<string, unknown>;
  functions: Record<string, unknown>;
  extensions: string[];
};

describe("committed schema fingerprint (Phase 0.1)", () => {
  it("is a real fingerprint, not the pending-generate placeholder", () => {
    expect(raw.sha256).not.toBe("pending-generate");
    expect(raw.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is at the current journal head", () => {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), "src/infrastructure/orm/migrations/meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number }[] };
    const head = Math.max(...journal.entries.map((e) => e.idx));
    expect(raw.journalIdx).toBe(head);
  });

  it("captures every object class the migrator diffs", () => {
    // A fingerprint that omits any of these makes the post-migrate diff
    // (runDesktopMigrations.ts) blind to drift in that class.
    expect(Object.keys(raw.tables).length).toBeGreaterThan(30);
    expect(Object.keys(raw.indexes).length).toBeGreaterThan(100);
    expect(Object.keys(raw.policies).length).toBeGreaterThan(0);
    expect(Object.keys(raw.triggers).length).toBeGreaterThan(0);
    expect(Object.keys(raw.functions).length).toBeGreaterThan(0);
    expect(raw.extensions).toContain("pg_trgm");
  });

  it("loadCommittedFingerprint() loads it — the fail-closed path is disarmed", () => {
    // This is the exact call runDesktopMigrations makes. A `null` here is the
    // boot-refusal bug; assert on the value, not just non-null, so an empty
    // object cannot pass either.
    const fp = loadCommittedFingerprint();
    expect(fp).not.toBeNull();
    expect(fp?.sha256).toBe(raw.sha256);
    expect(Object.keys(fp?.tables ?? {}).length).toBe(Object.keys(raw.tables).length);
  });
});
