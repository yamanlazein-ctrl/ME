/**
 * The render bridge: the backend asks the SHELL to turn a document into a PDF or a PNG.
 *
 * The two processes cannot call each other directly: the shell reaches the backend over the
 * runtime pipe (HTTP), and the backend has no channel to the shell. So the request is QUEUED in
 * `motard_drive_renders` and PULLED by the shell, which renders it and posts the artefact back
 * over the same route. This is the missing half of the archive: before it, the backend had no way
 * to ask the shell for anything, so the Drive archive could only ever upload CSV.
 *
 * The HTML travels in the request row. It is produced once, deterministically, by the shared
 * document builders, and the shell renders exactly those bytes.
 */
import { asc, eq } from "drizzle-orm";
import { motardDriveRenders } from "../orm/sqlite/schemas/drive-archive.table.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

/** How long the backend waits for the shell to render one document. */
const RENDER_WAIT_MS = 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

export type RenderRequest = {
  id: string;
  runId: string;
  artifactId: string;
  format: "pdf" | "png";
  outName: string;
  paper: string | null;
  html: string;
  state: "pending" | "rendered" | "failed";
  path: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  error: string | null;
};

/** Queue one document for the shell to render. */
export async function requestRender(
  db: DB,
  opts: {
    runId: string;
    artifactId: string;
    format: "pdf" | "png";
    outName: string;
    paper?: string | null;
    html: string;
  },
): Promise<string> {
  const id = randomUUID();
  await db.insert(motardDriveRenders).values({
    id,
    runId: opts.runId,
    artifactId: opts.artifactId,
    format: opts.format,
    outName: opts.outName,
    paper: opts.paper ?? null,
    html: opts.html,
    state: "pending",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  return id;
}

/** The pending requests, oldest first: what the shell pulls. */
export async function pendingRenders(db: DB, limit = 4): Promise<RenderRequest[]> {
  const rows = await db
    .select()
    .from(motardDriveRenders)
    .where(eq(motardDriveRenders.state, "pending"))
    .orderBy(asc(motardDriveRenders.createdAt))
    .limit(limit);
  return rows as RenderRequest[];
}

/** The shell reports a rendered artefact. */
export async function completeRender(
  db: DB,
  requestId: string,
  outcome: { path?: string; sha256?: string; sizeBytes?: number; error?: string },
): Promise<boolean> {
  const rendered = Boolean(outcome.path);
  await db
    .update(motardDriveRenders)
    .set({
      state: rendered ? "rendered" : "failed",
      path: outcome.path ?? null,
      sha256: outcome.sha256 ?? null,
      sizeBytes: outcome.sizeBytes ?? null,
      error: outcome.error ?? null,
      updatedAt: nowIso(),
    })
    .where(eq(motardDriveRenders.id, requestId));
  return rendered;
}

/** The outcome of waiting for a render. */
export type RenderOutcome =
  | { kind: "ok"; path: string; sha256: string; sizeBytes: number }
  /** The shell picked the request up and the render failed. */
  | { kind: "failed"; error: string }
  /** The shell never picked the request up: there is no shell on the other end. */
  | { kind: "absent" };

/**
 * Wait for the shell to render a queued request.
 *
 * The artefact is RE-HASHED here, from the file's own bytes: the shell's hash is a claim, and the
 * staged file is what gets uploaded to Drive.
 *
 * The outcome distinguishes "the shell is not there" from "the render failed" — the first is a
 * reason to fall back to the CSV export, the second is a reason to retry the document.
 */
export async function awaitRender(
  db: DB,
  requestId: string,
  timeoutMs = RENDER_WAIT_MS,
): Promise<RenderOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db
      .select()
      .from(motardDriveRenders)
      .where(eq(motardDriveRenders.id, requestId))
      .limit(1);
    if (!row) return { kind: "absent" };
    if (row.state === "failed") {
      return { kind: "failed", error: row.error ?? "فشل التصيير" };
    }
    if (row.state === "rendered" && row.path) {
      const bytes = await readFile(row.path).catch(() => null);
      if (!bytes) return { kind: "failed", error: "الملف المُنتج غير موجود" };
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { kind: "ok", path: row.path, sha256, sizeBytes: bytes.length };
    }
    // Still pending: nobody has taken it. If the wait runs out, there is no shell on the other end.
    if (Date.now() >= deadline) return { kind: "absent" };
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Forget a request once its outcome is known. Each row carries a whole document's HTML, so keeping
 * them grew the database with every archive pass; and a request that timed out ("absent") must not
 * stay pending, or a shell that starts later renders stale work nobody is waiting for.
 */
export async function discardRender(db: DB, requestId: string): Promise<void> {
  await db.delete(motardDriveRenders).where(eq(motardDriveRenders.id, requestId));
}
