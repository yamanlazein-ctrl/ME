/**
 * `npm run test:sqlite` — run the backend vitest suite against SQLite
 * (DB_ENGINE=sqlite). Cross-platform replacement for `DB_ENGINE=sqlite vitest run`,
 * which npm scripts cannot express on Windows. Extra arguments go to vitest.
 */
import { spawnSync } from "node:child_process";

const env = { ...process.env, DB_ENGINE: "sqlite" };
delete env.DATABASE_URL;
delete env.TEST_DB_URL;

const r = spawnSync("npx", ["vitest", "run", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
