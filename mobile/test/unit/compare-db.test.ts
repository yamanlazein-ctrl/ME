import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MIGRATIONS } from "../../src/core/generated/migrations";
import { openNodeShim } from "../helpers/nodeSqlite";
import { compareFiles } from "../../scripts/compare-db.mjs";

let dir = "";
const script = path.resolve(__dirname, "../../scripts/compare-db.mjs");

function build(file: string, amount: number, createdAt: string) {
  const db = openNodeShim(file);
  db.pragma("foreign_keys = OFF");
  for (const m of MIGRATIONS) db.exec(m.sql);
  const tenant = "11111111-1111-4111-8111-111111111111";
  db.prepare("INSERT INTO tenants (id, name, slug) VALUES (?, 'T', 't')").run(tenant);
  db.prepare(
    "INSERT INTO ledger_entries (id, tenant_id, date, type, debit, credit, created_at) VALUES (?, ?, '2026-01-15', 'sales_invoice', ?, 0, ?)",
  ).run("22222222-2222-4222-8222-222222222222", tenant, amount, createdAt);
  db.prepare(
    "INSERT INTO sync_outbox (seq, op_id, tenant_id, entity_type, entity_id, operation, payload) VALUES (1, ?, ?, 'party', ?, 'create', '{}')",
  ).run(randomUUID(), tenant, randomUUID());
  db.close();
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "motard-compare-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("compare-db", () => {
  it("two identical databases (timestamps and sync tables aside) print 0 differences", () => {
    build(path.join(dir, "a.db"), 100, "2026-01-15T10:00:00.000000Z");
    build(path.join(dir, "b.db"), 100, "2026-02-01T10:00:00.000000Z");
    expect(compareFiles(path.join(dir, "a.db"), path.join(dir, "b.db"))).toEqual([]);
    const out = execFileSync("node", [script, path.join(dir, "a.db"), path.join(dir, "b.db")], {
      encoding: "utf8",
    });
    expect(out.trim()).toBe("0 differences");
  });

  it("one changed amount prints exactly 1 difference", () => {
    build(path.join(dir, "c.db"), 100, "2026-01-15T10:00:00.000000Z");
    build(path.join(dir, "d.db"), 101, "2026-01-15T10:00:00.000000Z");
    const diffs = compareFiles(path.join(dir, "c.db"), path.join(dir, "d.db"));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("ledger_entries");
    expect(diffs[0]).toContain(".debit");
  });
});
