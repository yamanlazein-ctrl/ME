#!/usr/bin/env node
/**
 * prune-postgres.mjs — removes the parts of the bundled PostgreSQL runtime the desktop never uses.
 *
 * Fewer files = faster install and a faster cold start (every file is scanned by antivirus on first touch).
 * Everything removed here is provably unused by the desktop:
 *   share/locale       server-message translations (the cluster runs with lc_messages = C)
 *   share/doc          documentation
 *   share/postgresql   an exact duplicate of share/* (PostgreSQL resolves share/ relative to bin/ because the
 *                      install path already contains "postgres", so it never looks inside share/postgresql)
 *
 * Idempotent. The template gate (verify-pgdata-template.mjs) and server-bundle.test.mjs boot the pruned
 * runtime, so a removal that broke PostgreSQL fails the build.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "resources", "postgres");
if (!existsSync(join(PG, "bin", "postgres.exe"))) {
  console.error(`[prune-postgres] ERROR: ${PG} has no bin/postgres.exe`);
  process.exit(1);
}

const count = (d) =>
  readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(d, e.name)) : 1), 0);
const before = count(PG);

// share/postgresql is only a duplicate when share/ itself is complete — verify before removing it.
const shareOk = ["postgres.bki", "timezone", "extension", "tsearch_data"].every((f) => existsSync(join(PG, "share", f)));
const targets = ["share/locale", "share/doc", ...(shareOk ? ["share/postgresql"] : [])];
for (const rel of targets) {
  const p = join(PG, ...rel.split("/"));
  if (existsSync(p) && statSync(p).isDirectory()) {
    rmSync(p, { recursive: true, force: true });
    console.log(`[prune-postgres] removed ${rel}`);
  }
}
console.log(`[prune-postgres] OK — ${before} → ${count(PG)} files`);
