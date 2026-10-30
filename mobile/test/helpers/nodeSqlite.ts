// Test-only: a real better-sqlite3 connection (from backend/node_modules) typed as the phone shim.
// Never imported by app code; the app bundle maps `better-sqlite3` to BetterSqliteShim.ts instead.
import { createRequire } from "node:module";
import path from "node:path";
import type { ShimDatabase } from "../../src/platform/sqlite/types";

const requireFromBackend = createRequire(path.resolve(__dirname, "../../../backend/package.json"));
const BetterSqlite3 = requireFromBackend("better-sqlite3") as new (file: string) => unknown;

export function openNodeShim(file: string): ShimDatabase {
  return new BetterSqlite3(file) as ShimDatabase;
}
