#!/usr/bin/env node
/**
 * prune-postgres.mjs — remove from the bundled PostgreSQL everything the
 * desktop provably never loads.
 *
 * Two classes of waste, both real on this machine's staging tree:
 *
 *   1. Dead translations/docs/duplicate share trees (the original scope).
 *   2. DLLs no bundled executable loads. The staging step had accumulated ICU
 *      generations 67, 68 and 75 plus a duplicate iconv and wxWidgets leftovers
 *      (~85 MB) because it copied a `bin` folder several PostgreSQL installs had
 *      written into. The bundled server is 17.10 and needs exactly one of them.
 *
 * (2) is decided by READING BOTH PE IMPORT TABLES, not by guessing a version
 * number: every `.exe` in `bin` is parsed, the union of the DLLs they import —
 * static AND delay-loaded — is the keep-set, and any other `.dll` is removed.
 *
 * Two families are deliberately NOT derivable from an import table, and both
 * rules below were found by the build failing, not by guessing:
 *
 *   - ICU loads its own siblings through `LoadLibrary`, so `icuucNN` never
 *     appears as an import of `icuin/icuio/icutu/icudt`. Deleting them kills
 *     every backend with 0xC0000142 on the first query. The keep-set therefore
 *     always retains the COMPLETE generation of whichever `icuucNN` survived.
 *   - The remaining rule is the plain import closure below.
 *
 * A real `initdb` runs after the prune, and `validate-resource-manifest.mjs`
 * (a hard release gate) re-checks the ICU families, so a prune that removed
 * something loadable fails the build instead of shipping.
 *
 * Idempotent. Usage: node prune-postgres.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "resources", "postgres");
if (!existsSync(join(PG, "bin", "postgres.exe"))) {
  console.error(`[prune-postgres] ERROR: ${PG} has no bin/postgres.exe`);
  process.exit(1);
}

const binDir = join(PG, "bin");

/** Lowercased DLL names a PE executable loads, from its static AND delay tables. */
function loadedDlls(exePath) {
  const buf = readFileSync(exePath);
  const names = new Set();
  if (buf.length < 0x40 || buf.toString("latin1", 0, 2) !== "MZ") return names;

  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") return names;

  const coff = pe + 4;
  const sectionCount = buf.readUInt16LE(coff + 2);
  const optionalSize = buf.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const magic = buf.readUInt16LE(optional);
  const directories = optional + (magic === 0x20b ? 112 : 96);

  const sections = [];
  const sectionTable = optional + optionalSize;
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionTable + i * 40;
    sections.push({
      span: Math.max(buf.readUInt32LE(at + 8), buf.readUInt32LE(at + 16)),
      virtualAddress: buf.readUInt32LE(at + 12),
      rawPointer: buf.readUInt32LE(at + 20),
    });
  }
  const toOffset = (rva) => {
    for (const s of sections) {
      if (rva >= s.virtualAddress && rva < s.virtualAddress + s.span) {
        return s.rawPointer + (rva - s.virtualAddress);
      }
    }
    return -1;
  };
  const readCString = (rva) => {
    const at = toOffset(rva);
    if (at < 0) return null;
    let stop = at;
    while (stop < buf.length && buf[stop] !== 0) stop++;
    return buf.toString("latin1", at, stop).toLowerCase();
  };

  // Static imports: 20-byte descriptors, name RVA at +12, list ends on a
  // zeroed descriptor.
  const staticStart = toOffset(buf.readUInt32LE(directories + 8));
  const staticSize = buf.readUInt32LE(directories + 12);
  for (let at = staticStart, guard = 0; staticStart >= 0 && at < staticStart + staticSize && guard < 1024; guard++, at += 20) {
    if (buf.readUInt32LE(at) === 0 && buf.readUInt32LE(at + 12) === 0) break;
    const name = readCString(buf.readUInt32LE(at + 12));
    if (name) names.add(name);
  }

  // Delay imports (data directory 13): 32-byte descriptors, name RVA at +4,
  // bounded by the directory size rather than a terminator.
  const delayRva = buf.readUInt32LE(directories + 13 * 8);
  const delaySize = buf.readUInt32LE(directories + 13 * 8 + 4);
  if (delayRva) {
    const start = toOffset(delayRva);
    for (let at = start, guard = 0; start >= 0 && at < start + delaySize && guard < 1024; guard++, at += 32) {
      const name = readCString(buf.readUInt32LE(at + 4));
      if (name) names.add(name);
    }
  }
  return names;
}

/** Transitive closure over the DLLs sitting in the same folder. */
function loadClosure(seeds) {
  const keep = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.pop().toLowerCase();
    if (keep.has(name)) continue;
    keep.add(name);
    const path = join(binDir, name);
    if (existsSync(path)) queue.push(...loadedDlls(path));
  }
  return keep;
}

const count = (d) =>
  readdirSync(d, { withFileTypes: true }).reduce((n, e) => (e.isDirectory() ? n + count(join(d, e.name)) : n + 1), 0);

const before = count(PG);
const binFiles = readdirSync(binDir);

// ── 1. Dead share trees ──────────────────────────────────────────────────────
// share/postgresql is only a duplicate when share/ itself is complete.
const shareOk = ["postgres.bki", "timezone", "extension", "tsearch_data"].every((f) =>
  existsSync(join(PG, "share", f)),
);
for (const rel of ["share/locale", "share/doc", ...(shareOk ? ["share/postgresql"] : [])]) {
  const p = join(PG, ...rel.split("/"));
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log(`[prune-postgres] removed ${rel}`);
  }
}

// ── 2. DLLs nothing in bin/ loads ────────────────────────────────────────────
const seeds = new Set();
for (const exe of binFiles.filter((f) => f.toLowerCase().endsWith(".exe"))) {
  for (const dll of loadedDlls(join(binDir, exe))) seeds.add(dll);
}
const keep = loadClosure(seeds);

// ICU's own DLLs load each other at runtime, so no import table can see them.
// Keep the COMPLETE generation of whichever `icuucNN` survived: icudt, icuin,
// icuio, icutu and icuuc of that one version.
for (const name of [...keep]) {
  const m = /^icuuc(\d+)\.dll$/.exec(name);
  if (!m) continue;
  const generation = new RegExp(`^icu[a-z]*${m[1]}\\.dll$`, "i");
  for (const f of binFiles) if (generation.test(f)) keep.add(f.toLowerCase());
}

let removedBytes = 0;
for (const f of binFiles) {
  if (!f.toLowerCase().endsWith(".dll")) continue;
  if (keep.has(f.toLowerCase())) continue;
  const size = readFileSync(join(binDir, f)).length;
  rmSync(join(binDir, f));
  removedBytes += size;
  console.log(`[prune-postgres] removed bin/${f} (${(size / 1048576).toFixed(1)} MB, loaded by nothing)`);
}

const icuFamilies = binFiles.filter((f) => /^icu[a-z]+\d+\.dll$/i.test(f));
if (icuFamilies.length === 0) {
  console.error("[prune-postgres] ERROR: no ICU DLLs left — every backend would die with 0xC0000142");
  process.exit(1);
}

// ── 3. Prove the runtime still initialises a cluster ──────────────────────────
const scratch = mkdtempSync(join(tmpdir(), "prune-pg-"));
try {
  execFileSync(
    join(binDir, "initdb.exe"),
    ["-D", join(scratch, "data"), "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--locale=C"],
    { stdio: "pipe" },
  );
  console.log("[prune-postgres] initdb smoke test OK after prune");
} catch (e) {
  console.error("[prune-postgres] ERROR: the pruned runtime cannot initialise a cluster");
  console.error(e.stderr ? e.stderr.toString() : e.message);
  process.exit(1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  `[prune-postgres] OK — ${before} → ${count(PG)} files, ${(removedBytes / 1048576).toFixed(1)} MB of unloaded DLLs removed, ICU kept: ${icuFamilies.join(", ")}`,
);
