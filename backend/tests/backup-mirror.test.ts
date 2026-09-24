/**
 * Automatic backups are also copied OUTSIDE the app data folder, so deleting
 * %LOCALAPPDATA%\motard-erp cannot take the only backups with it.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorBackup, backupMirrorRoot } from "../src/infrastructure/backup/backupScheduler.js";

const src = mkdtempSync(join(tmpdir(), "bk-src-"));
const mirror = mkdtempSync(join(tmpdir(), "bk-mirror-"));
afterAll(() => {
  delete process.env.BACKUP_MIRROR_DIR;
  rmSync(src, { recursive: true, force: true });
  rmSync(mirror, { recursive: true, force: true });
});

describe("backup mirror", () => {
  it("defaults to Documents\Motard ERP Backups and can be disabled", () => {
    delete process.env.BACKUP_MIRROR_DIR;
    expect(backupMirrorRoot()).toMatch(/Documents.Motard ERP Backups$/);
    process.env.BACKUP_MIRROR_DIR = "off";
    expect(backupMirrorRoot()).toBeNull();
  });

  it("copies each backup and keeps the newest 7", async () => {
    process.env.BACKUP_MIRROR_DIR = mirror;
    for (let i = 0; i < 9; i++) {
      const f = join(src, `auto-${i}.zip`);
      writeFileSync(f, `zip ${i}`);
      const copied = await mirrorBackup(f);
      expect(copied).toBe(join(mirror, `auto-${i}.zip`));
    }
    const left = readdirSync(mirror).sort();
    expect(left).toHaveLength(7);
    expect(left).not.toContain("auto-0.zip");
    expect(left).toContain("auto-8.zip");
  });
});
