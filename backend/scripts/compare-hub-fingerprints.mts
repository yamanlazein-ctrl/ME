/**
 * MIG-04 — compare two hub fingerprints (GET /api/integrity/fingerprint on the frozen OLD server
 * and on the restored NEW one) before switching devices (docs/HUB-MIGRATION-RUNBOOK.md).
 *
 *   npx tsx scripts/compare-hub-fingerprints.mts old.json new.json
 *
 * Exit 0 only when every verified table, balance, roll and the sync stream head match.
 * Read-only: touches no database.
 */
import { readFileSync } from "node:fs";
import {
  compareFingerprints,
  type HubFingerprint,
} from "../src/infrastructure/integrity/hubFingerprintCompare.js";

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error("usage: npx tsx scripts/compare-hub-fingerprints.mts old.json new.json");
  process.exit(2);
}
const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as HubFingerprint;
const result = compareFingerprints(read(oldPath), read(newPath));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
