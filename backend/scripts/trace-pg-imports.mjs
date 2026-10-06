#!/usr/bin/env node
/**
 * FR-040 / T064 / T122 check: list every STATIC (non-type) import chain from an entry module to the
 * PostgreSQL layer (orm/drizzle.ts, or the `pg` driver). A DB_ENGINE=sqlite process evaluates every
 * statically imported module, so no such chain may exist. Dynamic `import()` is lazy and allowed.
 *
 *   node scripts/trace-pg-imports.mjs [entry=src/presentation/server.ts]
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const entry = resolve(root, process.argv[2] ?? "src/presentation/server.ts");
const TARGETS = [resolve(root, "src/infrastructure/orm/drizzle.ts")];

function staticImports(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  const re = /^\s*(import|export)\s+(?!type\b)([^'";]*?)\s*from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[3] ?? m[4];
    const clause = m[2] ?? "";
    // `import { type A, type B } from` is type-only too
    if (clause && /^\{[^}]*\}$/.test(clause.trim()) && clause.replace(/[{}\s]/g, "").split(",").filter(Boolean).every((x) => x.startsWith("type"))) continue;
    // the driver and drizzle's PostgreSQL adapter (its migrator was evaluated on SQLite; T122 coverage)
    if (spec === "pg" || spec.startsWith("drizzle-orm/node-postgres")) { out.push(spec); continue; }
    if (!spec.startsWith(".")) continue;
    const base = resolve(dirname(file), spec.replace(/\.js$/, ""));
    for (const cand of [`${base}.ts`, `${base}/index.ts`, `${base}.mts`]) {
      if (existsSync(cand)) { out.push(cand); break; }
    }
  }
  return out;
}

const seen = new Map();
const queue = [[entry, [entry]]];
const hits = [];
while (queue.length) {
  const [file, path] = queue.shift();
  if (seen.has(file)) continue;
  seen.set(file, path);
  for (const dep of staticImports(file)) {
    if (dep === "pg" || dep.startsWith("drizzle-orm/node-postgres") || TARGETS.includes(dep)) { hits.push([...path, dep]); continue; }
    if (!seen.has(dep)) queue.push([dep, [...path, dep]]);
  }
}
const rel = (p) => (p === "pg" || p.startsWith("drizzle-orm/") ? p :relative(root, p).replace(/\\/g, "/"));
if (!hits.length) {
  console.log(`[trace-pg-imports] OK — no static path from ${rel(entry)} reaches the PostgreSQL layer (${seen.size} modules scanned)`);
} else {
  for (const h of hits) console.log("PG reachable: " + h.map(rel).join(" → "));
  process.exit(1);
}
