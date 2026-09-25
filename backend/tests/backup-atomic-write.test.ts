/**
 * An automatic backup only carries its final `auto-*.zip` name once complete.
 * A copy interrupted by closing the app / a power cut used to leave a
 * truncated `auto-*.zip` that looked valid and counted toward the 7 kept.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mirrorBackup, pruneOldZips } from "@/infrastructure/backup/backupScheduler.js";

describe("backup mirror is written atomically", () => {
  let dir = "";
  let src = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-"));
    src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "src-")), "auto-2026-09-25T00-00-00-000Z.zip");
    fs.writeFileSync(src, Buffer.alloc(4096, 1));
    process.env.BACKUP_MIRROR_DIR = dir;
  });
  afterEach(() => {
    delete process.env.BACKUP_MIRROR_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("final file is complete, no .partial left, stale partials cleaned", async () => {
    fs.writeFileSync(path.join(dir, "auto-2026-09-24T00-00-00-000Z.zip.partial"), ""); // interrupted earlier copy
    const out = await mirrorBackup(src);
    expect(out).toBe(path.join(dir, path.basename(src)));
    expect(fs.statSync(out!).size).toBe(4096);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });

  it("pruning never counts partial files as backups", async () => {
    for (let i = 1; i <= 8; i++) fs.writeFileSync(path.join(dir, `auto-2026-09-${String(i).padStart(2, "0")}T00-00-00-000Z.zip`), "x");
    fs.writeFileSync(path.join(dir, "auto-2026-09-30T00-00-00-000Z.zip.partial"), "");
    await pruneOldZips(dir, 7);
    const zips = fs.readdirSync(dir).filter((f) => f.endsWith(".zip"));
    expect(zips).toHaveLength(7);
    expect(zips).not.toContain("auto-2026-09-01T00-00-00-000Z.zip");
  });
});
