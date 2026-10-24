/**
 * Phase 3 — hash-first change detection for the archive.
 *
 * A document is rendered to PDF (an expensive step) only when its SOURCE changed. The source hash is a
 * SHA-256 over the canonical fields that appear in the document: when the hash matches the one stored for
 * the last successful render, the existing archive file is still correct and the render is skipped.
 *
 * Pure functions only: the caller loads the rows, asks `decideRender`, and performs the render/upload.
 * Money is hashed from its stored decimal string, never from a float, so the same document always hashes
 * the same way.
 */
import { createHash } from "node:crypto";

/** Canonical JSON: keys sorted, no whitespace, so equal content always produces equal bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/**
 * The source hash of one document: everything that is printed. Include the document's own version too,
 * so an edit that changes nothing printed still re-renders (it is a real edit).
 */
export function sourceHash(source: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(source), "utf8").digest("hex");
}

export type RenderDecision =
  | { action: "render"; reason: "new" | "changed" | "previous-failed" }
  | { action: "skip"; reason: "unchanged" };

/**
 * Decide whether a document needs rendering. `previous` is the stored state of the last successful render
 * (null if the document was never rendered). A previous FAILED render is always retried.
 */
export function decideRender(
  current: { sourceHash: string },
  previous: { sourceHash: string; status: "done" | "failed" } | null,
): RenderDecision {
  if (!previous) return { action: "render", reason: "new" };
  if (previous.status === "failed") return { action: "render", reason: "previous-failed" };
  if (previous.sourceHash !== current.sourceHash) return { action: "render", reason: "changed" };
  return { action: "skip", reason: "unchanged" };
}

/** Summary of one bundle pass, for progress reporting and the run record. */
export type BundleTally = { rendered: number; skipped: number; failed: number };

export function tally(decisions: RenderDecision[]): BundleTally {
  return decisions.reduce<BundleTally>(
    (t, d) => {
      if (d.action === "skip") t.skipped++;
      else t.rendered++;
      return t;
    },
    { rendered: 0, skipped: 0, failed: 0 },
  );
}
