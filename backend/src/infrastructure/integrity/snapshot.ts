/**
 * REPAIR-024 — pre-operation snapshot via pg_dump -Fc (desktop).
 * Failure refuses the dangerous operation (caller must check return value).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { logger } from "../config/logger.js";

export type SnapshotOperation =
  | "migrate"
  | "legacy_repair"
  | "factory_reset"
  | "restore"
  | "upgrade";

export type SnapshotSidecar = {
  operationId: string;
  operation: SnapshotOperation;
  createdAt: string;
  schemaJournalIdx: number | null;
  tenantId: string | null;
  databaseSizeBytes: number | null;
  rowCounts: Record<string, number> | null;
  sha256: string;
};

const RETENTION_COUNT = 5; // §19 Q18
const RETENTION_DAYS = 30;

function snapshotsRoot(): string {
  const integrity = process.env.DATA_INTEGRITY_PATH;
  if (integrity) return join(dirname(integrity), "snapshots");
  return join(process.env.LOG_DIR ?? ".", "..", "snapshots");
}

function findPgDump(): string | null {
  const candidates = [
    process.env.PG_DUMP_PATH,
    process.env.POSTGRES_BIN
      ? join(process.env.POSTGRES_BIN, process.platform === "win32" ? "pg_dump.exe" : "pg_dump")
      : null,
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function takePreOpSnapshot(opts: {
  databaseUrl: string;
  operation: SnapshotOperation;
  operationId: string;
  schemaJournalIdx?: number | null;
  tenantId?: string | null;
  rowCounts?: Record<string, number> | null;
}): Promise<{ ok: true; path: string; sidecar: SnapshotSidecar } | { ok: false; reason: string }> {
  const pgDump = findPgDump();
  if (!pgDump) {
    const reason = "pg_dump not found — refuse operation without snapshot (REPAIR-024)";
    logger.fatal({ bootId: process.env.MOTARD_BOOT_ID }, `[FATAL] ${reason}`);
    return { ok: false, reason };
  }
  const root = snapshotsRoot();
  await mkdir(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${stamp}_${opts.operation}_${opts.operationId}`;
  const dumpPath = join(root, `${base}.dump`);
  const sidecarPath = join(root, `${base}.json`);

  const r = spawnSync(
    pgDump,
    ["-Fc", "--no-owner", "--no-acl", "-f", dumpPath, opts.databaseUrl],
    { encoding: "utf8", windowsHide: true, timeout: 30 * 60 * 1000 },
  );
  if (r.status !== 0 || !existsSync(dumpPath)) {
    const reason = `SNAPSHOT_FAILED: ${r.stderr || r.stdout || `exit ${r.status}`}`;
    logger.fatal({ bootId: process.env.MOTARD_BOOT_ID }, `[FATAL] ${reason}`);
    await rm(dumpPath, { force: true }).catch(() => {});
    return { ok: false, reason };
  }

  const buf = await readFile(dumpPath);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const sidecar: SnapshotSidecar = {
    operationId: opts.operationId,
    operation: opts.operation,
    createdAt: new Date().toISOString(),
    schemaJournalIdx: opts.schemaJournalIdx ?? null,
    tenantId: opts.tenantId ?? null,
    databaseSizeBytes: buf.length,
    rowCounts: opts.rowCounts ?? null,
    sha256,
  };
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
  try {
    // Immutable: best-effort read-only on Windows/Unix
    await chmod(dumpPath, 0o444);
    await chmod(sidecarPath, 0o444);
  } catch {
    /* ACL may deny chmod on Windows — ignore */
  }

  await pruneSnapshots(root).catch((err) =>
    logger.warn({ err }, "snapshot prune failed"),
  );
  logger.info(
    { bootId: process.env.MOTARD_BOOT_ID, dumpPath, operation: opts.operation },
    "SNAPSHOT_CREATED",
  );
  return { ok: true, path: dumpPath, sidecar };
}

async function pruneSnapshots(root: string): Promise<void> {
  const entries = (await readdir(root))
    .filter((f) => f.endsWith(".dump"))
    .map((f) => join(root, f));
  const withStat = await Promise.all(
    entries.map(async (p) => ({ p, mtime: (await stat(p)).mtimeMs })),
  );
  withStat.sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (let i = 0; i < withStat.length; i++) {
    const { p, mtime } = withStat[i]!;
    const keepByCount = i < RETENTION_COUNT;
    const keepByAge = mtime >= cutoff;
    if (keepByCount || keepByAge) continue;
    if (i === 0) continue; // never delete newest
    try {
      await chmod(p, 0o666).catch(() => {});
      await rm(p, { force: true });
      await rm(p.replace(/\.dump$/, ".json"), { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Used by tests — rename helper avoids unused import warnings in some builds. */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
