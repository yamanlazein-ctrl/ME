/**
 * DFP-028 — backup/restore scripts must fail closed (static contract).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const backup = readFileSync(resolve(root, "scripts/backup/backup.sh"), "utf8");
const restore = readFileSync(resolve(root, "scripts/backup/restore.sh"), "utf8");

test("DFP-028 backup defaults to rclone copy; sync is opt-in", () => {
  assert.match(backup, /BACKUP_ALLOW_RCLONE_SYNC/);
  assert.match(backup, /rclone copy/);
  assert.match(backup, /VERIFY_RESTORE/);
  assert.doesNotMatch(backup, /xargs\s+-0\s+export/);
});

test("DFP-028 restore requires explicit confirm and refuses prod-like names", () => {
  assert.match(restore, /RESTORE_CONFIRM/);
  assert.match(restore, /RESTORE_ALLOW_PRODUCTION/);
  assert.match(restore, /ON_ERROR_STOP/);
});
