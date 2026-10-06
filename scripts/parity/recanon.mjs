#!/usr/bin/env node
/** Re-run only the canonical export from a saved raw run (out/raw/<engine>.raw) — no backend needed. */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "./lib/canonical.mjs";
const [engine, out] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(new URL(`./out/raw/${engine}.raw`, import.meta.url), "utf8"));
const canon = canonicalize(raw);
rmSync(join(out, "api"), { recursive: true, force: true });
rmSync(join(out, "tables"), { recursive: true, force: true });
mkdirSync(join(out, "api"), { recursive: true });
mkdirSync(join(out, "tables"), { recursive: true });
for (const [k, v] of Object.entries(canon.transcript)) writeFileSync(join(out, "api", `${k}.json`), JSON.stringify(v, null, 2));
for (const [k, v] of Object.entries(canon.tables)) writeFileSync(join(out, "tables", `${k}.json`), JSON.stringify(v, null, 2));
console.log(`[parity:recanon] ${engine} → ${out}`);
