/**
 * Migration journal ↔ disk parity guards (P0-001).
 *
 * drizzle's runtime migrator (`readMigrationFiles` from `drizzle-orm/migrator`)
 * walks ONLY the entries listed in `meta/_journal.json` and loads `<tag>.sql`
 * for each of them. The two failure directions are asymmetric:
 *
 *  1. A `.sql` file that exists on disk but is NOT in the journal is SILENTLY
 *     IGNORED — `db:migrate` never executes it, so a fresh database ends up
 *     missing the column/table it declares. This is exactly how
 *     `0046_user_pin_hash` (`users.pin_hash`, used by the device PIN picker and
 *     the PIN-set flow) went missing on fresh installs: every already-migrated
 *     install kept working, so nothing ever failed loudly.
 *
 *  2. A journal entry whose `.sql` file is absent makes the migrator THROW
 *     (`No file <tag>.sql found in <folder> folder`), hard-breaking every
 *     future `db:migrate` — including the ones for tables that already exist.
 *
 * `drizzle-kit generate` normally keeps both sides in sync. This project ships
 * many hand-written migrations, so the invariant is locked in by a test.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(BACKEND_ROOT, "src", "infrastructure", "orm", "migrations");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

interface JournalEntry {
  idx: number;
  version: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function readJournal(): { version: number; dialect: string; entries: JournalEntry[] } {
  return JSON.parse(readFileSync(JOURNAL_PATH, "utf8"));
}

function sqlTagsOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, -".sql".length));
}

describe("migration journal ↔ disk parity guards (P0-001)", () => {
  it("every .sql file on disk is registered in meta/_journal.json", () => {
    const registered = new Set(readJournal().entries.map((e) => e.tag));

    const orphans = sqlTagsOnDisk().filter((tag) => !registered.has(tag));

    expect(
      orphans,
      `migrations present on disk but missing from _journal.json — db:migrate will never run them:\n${orphans.join("\n")}`,
    ).toEqual([]);
  });

  it("every journal entry has a matching .sql file (else migrate throws)", () => {
    const onDisk = new Set(sqlTagsOnDisk());

    const dangling = readJournal()
      .entries.map((e) => e.tag)
      .filter((tag) => !onDisk.has(tag));

    expect(
      dangling,
      `journal entries without a .sql file — readMigrationFiles() throws on these:\n${dangling.join("\n")}`,
    ).toEqual([]);
  });

  it("journal idx is sequential and `when` is strictly ascending", () => {
    const { entries } = readJournal();

    const badIdx = entries
      .filter((e, i) => e.idx !== i)
      .map((e, i) => `position ${i} carries idx ${e.idx} (${e.tag})`);
    expect(badIdx, `journal idx is not a dense 0..n-1 sequence:\n${badIdx.join("\n")}`).toEqual([]);

    const badWhen: string[] = [];
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const cur = entries[i];
      if (!(cur.when > prev.when)) badWhen.push(`${prev.tag} (${prev.when}) -> ${cur.tag} (${cur.when})`);
    }
    expect(
      badWhen,
      `journal \`when\` is not strictly ascending — the migrator's skip check compares it against __drizzle_migrations.created_at:\n${badWhen.join("\n")}`,
    ).toEqual([]);
  });

  it("drizzle's own migrator resolves every journal entry, carrying `when` through", () => {
    const { entries } = readJournal();
    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });

    expect(migrations).toHaveLength(entries.length);
    // folderMillis is what pg-core/dialect.cjs compares against created_at.
    expect(migrations.map((m) => m.folderMillis)).toEqual(entries.map((e) => e.when));
    // every migration must carry at least one statement
    expect(migrations.filter((m) => m.sql.join("").trim() === "")).toEqual([]);
  });

  it("a FRESH database applies 0046_user_pin_hash (simulated migrator pass)", () => {
    const { entries } = readJournal();
    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });

    // Mirrors drizzle-orm/pg-core/dialect.cjs: `lastDbMigration` is read ONCE
    // from `__drizzle_migrations order by created_at desc limit 1`, then each
    // migration runs when folderMillis > lastDbMigration.created_at.
    const lastDbMigration: number | null = null; // fresh DB → no rows
    const appliedTags = entries
      .filter((e) => lastDbMigration === null || lastDbMigration < e.when)
      .map((e) => e.tag);

    expect(appliedTags).toContain("0046_user_pin_hash");

    const i = entries.findIndex((e) => e.tag === "0046_user_pin_hash");
    expect(migrations[i].sql.join("\n")).toMatch(/ADD COLUMN IF NOT EXISTS pin_hash/i);
    // and it must land before the sync tables that followed it
    expect(appliedTags.indexOf("0046_user_pin_hash")).toBeLessThan(appliedTags.indexOf("0047_sync_devices"));
  });
  it("a FRESH database applies 0058_sync_tombstones before the migration that references it (regression: orphaned journal entry)", () => {
    const { entries } = readJournal();
    const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });

    // 0058_sync_tombstones.sql existed on disk but had NO _journal.json entry,
    // so db:migrate silently skipped it while 20260912_batch1_tombstones_
    // conflicts (which inserts INTO sync_tombstones) ran — fresh installs
    // failed at batch1 with relation "sync_tombstones" does not exist.
    const tombIdx = entries.findIndex((e) => e.tag === "0058_sync_tombstones");
    expect(tombIdx, "0058_sync_tombstones must be registered in _journal.json").toBeGreaterThan(-1);
    const batchIdx = entries.findIndex((e) => e.tag === "20260912_batch1_tombstones_conflicts");
    expect(batchIdx).toBeGreaterThan(tombIdx);

    const tombSql = migrations[tombIdx].sql.join("\n");
    expect(tombSql).toMatch(/CREATE TABLE IF NOT EXISTS "?sync_tombstones"?/i);
    const batchSql = migrations[batchIdx].sql.join("\n");
    expect(batchSql).toMatch(/sync_tombstones/i);
  });

  it("an already up-to-date database is a no-op (idempotent re-run)", () => {
    const { entries } = readJournal();
    const lastDbMigration = Math.max(...entries.map((e) => e.when));

    const wouldRun = entries.filter((e) => lastDbMigration < e.when).map((e) => e.tag);

    expect(wouldRun, "a fully migrated DB must apply nothing on re-run").toEqual([]);
  });
});
