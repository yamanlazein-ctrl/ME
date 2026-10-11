import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// FE-01: a success message ("تم …" = "done") rendered with toast.error tells the operator a landed
// operation failed, so they re-submit it. Textual guard on purpose — it pins wiring, not behaviour.
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

describe("toast semantics", () => {
  // RV-01: this walks the entire src/ tree with readFileSync; under parallel worker load it exceeds
  // vitest's 5000 ms default. Targeted timeout (same pattern as dfp029-credentials.test.ts) —
  // a global raise would hide real hangs.
  it("no success message is shown as an error toast", () => {
    const offenders = sources(join(__dirname, "../../..")).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/toast\.error\(\s*[`"']تم/g)].map(() => f),
    );
    expect(offenders).toEqual([]);
  }, 30_000);
});
