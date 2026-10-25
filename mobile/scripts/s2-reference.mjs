// Writes specs/002-mobile-app/evidence/s2-reference.db: the S2 routine (src/core/spikeS2.ts) run under Node through the
// phone container over better-sqlite3. The phone's S2 export is compared to it with scripts/compare-db.mjs.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../specs/002-mobile-app/evidence/s2-reference.db");
const result = spawnSync(
  "npx",
  ["vitest", "run", "test/s2/s2.test.ts", "-t", "writes the reference database"],
  { cwd: path.resolve(here, ".."), env: { ...process.env, S2_OUT: out }, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`wrote ${out}`);
