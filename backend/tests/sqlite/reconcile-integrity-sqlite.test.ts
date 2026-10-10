/**
 * N-01 (ERP_VERIFIED_ISSUES_AND_REMEDIATION_PLAN): the SQLite reconciliation
 * tool must actually DETECT corruption, not just run. This suite builds a
 * fresh SQLite database with the project's own baseline migration, seeds a
 * consistent tenant, runs the tool (all checks pass), then deliberately breaks
 * each guarded invariant and asserts the tool reports it and exits non-zero.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = join(BACKEND_ROOT, "scripts", "reconcile-integrity-sqlite.mjs");
const BASELINE = join(BACKEND_ROOT, "src", "infrastructure", "orm", "sqlite", "migrations", "0000_baseline.sql");

const root = mkdtempSync(join(tmpdir(), "motard-recon-"));
const dbPath = join(root, "motard.db");
const TENANT = randomUUID();
let db: Database.Database;

function runTool(extra = []) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [TOOL, "--db", dbPath, "--tenant", TENANT, ...extra],
      { encoding: "utf8" },
    );
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? 1, out: JSON.parse(err.stdout ?? "{}") };
  }
}

beforeAll(() => {
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  // Apply the project's own baseline schema, then seed a consistent tenant.
  const baseline = mkdtempSync(join(tmpdir(), "motard-recon-sql-"));
  rmSync(baseline, { recursive: true, force: true });
  db.exec('BEGIN');
  db.exec("PRAGMA defer_foreign_keys = ON");
  const sql = readBaseline();
  db.exec(sql);
  db.exec("COMMIT");

  db.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة الفحص', 'recon')`).run(TENANT);
}, 60_000);

afterAll(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

function readBaseline(): string {
  return readFileSync(BASELINE, "utf8");
}

/** SQLite date columns take plain YYYY-MM-DD (see ck_sqlite_date checks). */
const today = () => new Date().toISOString().slice(0, 10);

describe("reconcile-integrity-sqlite (N-01)", () => {
  it("passes on a consistent tenant", () => {
    const { code, out } = runTool();
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.failures).toEqual([]);
  }, 120_000);

  it("detects a roll whose remaining_kg diverges from its last movement", () => {
    const partyId = randomUUID();
    const rollId = randomUUID();
    db.prepare(`INSERT INTO parties (id, tenant_id, kind, name, code, version) VALUES (?, ?, 'customer', 'عميل', 'C1', 1)`).run(partyId, TENANT);
    // rolls.color_id has a real FK to colors — seed the chain fabrics → colors.
    const fabricId = randomUUID();
    const colorId = randomUUID();
    db.prepare(
      `INSERT INTO fabrics (id, tenant_id, name, min_stock_kg, version) VALUES (?, ?, 'قماش الفحص', 0, 1)`,
    ).run(fabricId, TENANT);
    db.prepare(
      `INSERT INTO colors (id, tenant_id, fabric_id, name, version) VALUES (?, ?, ?, 'لون الفحص', 1)`,
    ).run(colorId, TENANT, fabricId);
    db.prepare(
      `INSERT INTO rolls (id, tenant_id, color_id, roll_no, initial_kg, remaining_kg, price_per_kg, entry_date, status, version)
       VALUES (?, ?, ?, 'R-1', 5000, 5000, 100, ?, 'in_stock', 1)`,
    ).run(rollId, TENANT, colorId, today());
    db.prepare(
      `INSERT INTO stock_movements (id, tenant_id, roll_id, direction, movement_type, quantity_kg, balance_after_kg, movement_date)
       VALUES (?, ?, ?, 'in', 'adjust', 5000, 3000, ?)`,
    ).run(randomUUID(), TENANT, rollId, today());

    const { code, out } = runTool();
    expect(code).toBe(1);
    const checks = out.failures.map((f: { check: string }) => f.check);
    expect(checks).toContain("stock_vs_movements");

    // Clean up so later tests start from the consistent state again.
    db.prepare(`DELETE FROM stock_movements WHERE roll_id = ?`).run(rollId);
    db.prepare(`DELETE FROM rolls WHERE id = ?`).run(rollId);
    db.prepare(`DELETE FROM colors WHERE id = ?`).run(colorId);
    db.prepare(`DELETE FROM fabrics WHERE id = ?`).run(fabricId);
    db.prepare(`DELETE FROM parties WHERE id = ?`).run(partyId);
  }, 120_000);

  it("detects a dead sync_outbox unit", () => {
    db.prepare(
      `INSERT INTO sync_outbox (id, tenant_id, op_id, entity_type, entity_id, operation, payload, status, seq)
       VALUES (?, ?, ?, 'invoice', ?, 'create', '{}', 'dead', 1)`,
    ).run(randomUUID(), TENANT, randomUUID(), randomUUID());
    const { code, out } = runTool();
    expect(code).toBe(1);
    const checks = out.failures.map((f: { check: string }) => f.check);
    expect(checks).toContain("sync_dead");
    db.prepare(`DELETE FROM sync_outbox WHERE tenant_id = ? AND status = 'dead'`).run(TENANT);
  }, 120_000);
});
