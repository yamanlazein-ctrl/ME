/**
 * CODEBASE_AUDIT_REPORT_hermes C1-09 (same root cause as F-011) — every label in the settings pages
 * names its control: a raw <Label> must carry htmlFor; plain fields go through FormField, which wires
 * its single Input by itself (FormField.test.tsx proves that wiring).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const files = readdirSync(__dirname).filter(
  (f) => /^settings\..*\.tsx$/.test(f) && !f.includes(".test."),
);

describe("settings pages: label ↔ control", () => {
  it.each(files)("%s has no <Label> without htmlFor", (f) => {
    const src = readFileSync(join(__dirname, f), "utf8");
    const bare = [...src.matchAll(/<Label\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((t) => !t.includes("htmlFor"));
    expect(bare).toEqual([]);
  });
});
