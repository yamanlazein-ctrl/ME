#!/usr/bin/env node
/**
 * REPAIR-030 — upgrade-over-real-data matrix scaffold.
 * Checklist only — NOT an automated test (see docs/PROJECT-STATUS.md §3.3).
 * Exit 0 when checklist file is present; expand with real AppData copies in CI.
 */
const scenarios = [
  "S-1 first install",
  "S-3 reuse healthy",
  "S-5 migration pending + snapshot",
  "S-6 severe drop → SAFE_MODE",
  "S-7 missing pgdata + meta",
  "S-8 factory reset authorized",
  "S-14 backup incomplete refused",
  "S-16 restore drill",
  "S-17 fingerprint mismatch",
  "S-18 tenant mismatch",
];
console.log("REPAIR-030 upgrade matrix (scaffold):");
for (const s of scenarios) console.log(`  [ ] ${s}`);
console.log("Attach green results to release notes before shipping post-Phase-0 installers.");
process.exit(0);
