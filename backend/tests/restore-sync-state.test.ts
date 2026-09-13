import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Backup/restore consistency guard (SYNC-OPERATIONS.md §Backup/restore).
 *
 * The defect this locks down: POST /api/backup/full dumped the sync tables
 * (`sync_outbox`, `sync_inbox`, `sync_state`, `sync_devices`,
 * `sync_resource_claims`, `sync_tombstones`, `sync_conflicts`,
 * `document_number_blocks`) but `scripts/restore-from-backup.mjs` had no entry
 * for ANY of them in INSERT_ORDER/DELETE_ORDER. A restore therefore silently
 * dropped every un-pushed operation, the applied-op mirror, the pull cursor,
 * the first-write-wins claims, the deletion tombstones and the device number
 * blocks — while the docs claimed sync state is restored with the business data.
 *
 * The invariant: what the backup exports, the restore must restore — in FK-safe
 * order, with the sequence-backed ordering columns advanced afterwards.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, "..");
const BACKUP_ROUTE = path.join(BACKEND, "src", "presentation", "routes", "backup.route.ts");
const RESTORE_SCRIPT = path.join(BACKEND, "scripts", "restore-from-backup.mjs");
const SCHEMAS_DIR = path.join(BACKEND, "src", "infrastructure", "orm", "schemas");

const backupSrc = fs.readFileSync(BACKUP_ROUTE, "utf8");
const restoreSrc = fs.readFileSync(RESTORE_SCRIPT, "utf8");

/** Tables POST /api/backup/full exports for a tenant. */
function backedUpTables(): string[] {
  const start = backupSrc.indexOf("const tenantTables = [");
  const end = backupSrc.indexOf("];", start);
  return [...backupSrc.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

function arrayLiteral(name: string): string[] {
  const start = restoreSrc.indexOf(`const ${name} = [`);
  const end = restoreSrc.indexOf("];", start);
  return [...restoreSrc.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** `{ table, column }` entries of SERIAL_COLUMNS. */
function serialColumns(): Array<{ table: string; column: string }> {
  const start = restoreSrc.indexOf("const SERIAL_COLUMNS = [");
  const end = restoreSrc.indexOf("];", start);
  return [...restoreSrc.slice(start, end).matchAll(/table:\s*"(\w+)",\s*column:\s*"(\w+)"/g)].map(
    (m) => ({ table: m[1], column: m[2] }),
  );
}

/**
 * bigserial columns declared by the ORM schemas, keyed by their real DATABASE
 * column name (the JS property may differ: `receivedSeq: bigserial("received_seq")`).
 */
function bigserialColumns(): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  for (const f of fs.readdirSync(SCHEMAS_DIR)) {
    if (!f.endsWith(".table.ts")) continue;
    const src = fs.readFileSync(path.join(SCHEMAS_DIR, f), "utf8");
    const table = /pgTable\(\s*"([a-z_]+)"/.exec(src)?.[1];
    if (!table) continue;
    for (const m of src.matchAll(/\w+:\s*bigserial\(\s*"([a-z_]+)"/g)) {
      out.push({ table, column: m[1] });
    }
  }
  return out;
}

/**
 * Tables the restore intentionally UPSERTS instead of deleting first
 * (documented in the script header: "tenants/users/company_profiles/settings
 * are upserted, never deleted"). Deleting the operator's own user row while a
 * restore is running is a bigger hazard than keeping a slightly newer row.
 * Consequence, tracked as a known limitation: when such a row already exists,
 * `ON CONFLICT DO NOTHING` keeps the CURRENT row rather than the backup's.
 */
const UPSERT_ONLY = new Set(["tenants", "users", "company_profiles", "settings"]);

describe("backup → restore consistency (sync state is durable data)", () => {
  const backup = backedUpTables();
  const insertOrder = arrayLiteral("INSERT_ORDER");
  const deleteOrder = arrayLiteral("DELETE_ORDER");

  it("the backup exports a sane table inventory", () => {
    expect(backup.length).toBeGreaterThanOrEqual(30);
    for (const t of ["sync_outbox", "sync_inbox", "sync_state", "sync_devices"]) {
      expect(backup, `backup must export ${t}`).toContain(t);
    }
  });

  it("every exported table is restored (INSERT_ORDER)", () => {
    const missing = backup.filter((t) => !insertOrder.includes(t));
    expect(
      missing,
      `tables exported by the backup but never restored (their rows are silently lost): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every exported table except the upsert-only ones is wiped first (DELETE_ORDER)", () => {
    const missing = backup.filter((t) => !UPSERT_ONLY.has(t) && !deleteOrder.includes(t));
    expect(
      missing,
      `tables exported by the backup but not cleared before restore (they would keep rows from AFTER the backup): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("sync tables are ordered so foreign keys hold in both directions", () => {
    const dependents = [
      "sync_outbox",
      "sync_inbox",
      "sync_resource_claims",
      "document_number_blocks",
      "sync_tombstones",
    ];
    for (const child of dependents) {
      expect(
        insertOrder.indexOf("sync_devices"),
        `${child} references sync_devices → sync_devices must be inserted first`,
      ).toBeLessThan(insertOrder.indexOf(child));
      expect(
        deleteOrder.indexOf("sync_devices"),
        `${child} references sync_devices → it must be deleted first`,
      ).toBeGreaterThan(deleteOrder.indexOf(child));
    }
  });

  it("every sequence-backed ordering column is advanced after the restore", () => {
    const restoredTables = new Set(insertOrder);
    const required = bigserialColumns().filter((c) => restoredTables.has(c.table));
    const wired = serialColumns();
    const missing = required.filter(
      (c) => !wired.some((w) => w.table === c.table && w.column === c.column),
    );
    expect(
      missing,
      `bigserial ordering columns restored without a sequence fix-up (new rows would sort BEFORE the restored ones): ` +
        missing.map((c) => `${c.table}.${c.column}`).join(", "),
    ).toEqual([]);
  });

  it("the pull cursor is restored with an explicit, documented rule", () => {
    expect(restoreSrc).toContain("last_pull_seq");
    expect(restoreSrc, "cursor needs a reset escape hatch for a different hub").toContain(
      "--reset-pull-cursor",
    );
    expect(
      restoreSrc,
      "a cursor above the highest restored received_seq must be clamped, not trusted",
    ).toContain("CLAMPED");
  });

  it("a restore that loses un-pushed operations fails instead of reporting success", () => {
    expect(restoreSrc).toContain("PENDING-OUTBOX INVARIANT");
    expect(restoreSrc, "pending/pushing are the un-pushed statuses").toMatch(
      /status\s+IN\s*\('pending','pushing'\)/,
    );
  });
});
