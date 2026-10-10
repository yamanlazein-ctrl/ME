/**
 * F-08 (ERP_VERIFIED_ISSUES_AND_REMEDIATION_PLAN): `uuidFromString` is
 * deliberately duplicated between syncEnqueue.ts and syncUseCases.ts (the
 * enqueue module is the dependency leaf of the sync surface, so it must not
 * import from syncUseCases). The duplication is an accepted trade-off, BUT the
 * two implementations must stay byte-identical: the derived UUIDs are sync
 * entity/resource keys, so a divergence silently breaks cross-device key
 * matching. This test is the guard that makes the accepted trade-off safe.
 *
 * Note: this is a regression lock, not a bug fix — the implementations are
 * identical today and must remain so.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Extract the full function source from a module file. */
function functionSource(file: string, fn: string): string {
  const src = readFileSync(join(BACKEND_ROOT, file), "utf8");
  const start = src.indexOf(`function ${fn}(`);
  if (start === -1) throw new Error(`${fn} not found in ${file}`);
  // Function ends at the first line that starts with "}" at column 0.
  const end = src.indexOf("\n}", start);
  if (end === -1) throw new Error(`${fn} end not found in ${file}`);
  return src.slice(start, end + 2);
}

describe("uuidFromString duplication guard (F-08)", () => {
  it("the two implementations are byte-identical (same UUIDs on every device)", () => {
    const a = functionSource(
      "src/application/use-cases/sync/syncEnqueue.ts",
      "uuidFromString",
    );
    const b = functionSource(
      "src/application/use-cases/sync/syncUseCases.ts",
      "uuidFromString",
    );
    // Normalize the leading "export " difference only; everything else must match.
    expect(a.replace(/^export\s+/, "")).toBe(b.replace(/^export\s+/, ""));
  });

  it("the implementation matches the documented SHA-256 8-4-4-4-12 shape", () => {
    const a = functionSource(
      "src/application/use-cases/sync/syncEnqueue.ts",
      "uuidFromString",
    );
    expect(a).toContain("createHash");
    expect(a).toContain('h.slice(0, 8)');
    // If either implementation changes shape, this test forces a conscious
    // update of BOTH files together.
  });
});
