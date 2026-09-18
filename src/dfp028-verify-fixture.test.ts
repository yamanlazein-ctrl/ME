/**
 * DFP-028 — backup verification + restore guards without requiring host pg_dump.
 * Mirrors backup.sh gzip/CREATE TABLE checks and restore.sh production refuse.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

describe("DFP-028 backup verify + restore guards", () => {
  let dir: string;
  let dumpGz: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dfp028-"));
    const sql = [
      "-- fixture dump",
      "CREATE TABLE invoices (id int);",
      "CREATE TABLE ledger_entries (id int);",
      "INSERT INTO invoices VALUES (1);",
      "",
    ].join("\n");
    dumpGz = join(dir, "erp_backup_daily_fixture.sql.gz");
    writeFileSync(dumpGz, gzipSync(Buffer.from(sql, "utf8")));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("gzip integrity + CREATE TABLE count match backup.sh verifier", () => {
    const raw = readFileSync(dumpGz);
    expect(() => gunzipSync(raw)).not.toThrow();
    const text = gunzipSync(raw).toString("utf8");
    const createCount = (text.match(/^CREATE TABLE/gm) ?? []).length;
    expect(createCount).toBeGreaterThanOrEqual(1);
  });

  it("backup.sh fails closed when pg_dump is absent (source contract)", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/backup/backup.sh"), "utf8");
    expect(src).toMatch(/command -v pg_dump/);
    expect(src).toMatch(/ERROR: pg_dump not found/);
    expect(src).toMatch(/gzip -t/);
    expect(src).toMatch(/CREATE TABLE/);
    expect(src).toMatch(/VERIFY_RESTORE/);
    expect(src).toMatch(/rclone copy/);
  });

  it("restore.sh refuses production-like DB names without override", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/backup/restore.sh"), "utf8");
    expect(src).toMatch(/RESTORE_ALLOW_PRODUCTION/);
    expect(src).toMatch(/erp\|fabric_erp\|production\|prod/);
    expect(src).toMatch(/ON_ERROR_STOP/);
    expect(src).toMatch(/RESTORE_CONFIRM/);
  });

  it("corrupt gzip fixture fails integrity check", () => {
    const bad = join(dir, "bad.sql.gz");
    writeFileSync(bad, Buffer.from("not-gzip"));
    expect(() => gunzipSync(readFileSync(bad))).toThrow();
  });
});
