// Every colour of the UI comes from the theme tokens (theme.ts), so both themes stay readable. Two deliberate exceptions:
// the camera overlay (always over a live camera image) and the dimmed backdrop behind a sheet.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const ALLOWED = new Set(["src/ui/tokens.generated.ts", "src/ui/theme.ts", "app/spikes.tsx"]);
const EXCEPTIONS: Array<[string, string]> = [
  ["src/ui/ScanView.tsx", '"#ffffff"'],
  ["src/ui/kit/Sheet.tsx", '"rgba(0,0,0,0.55)"'],
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx?|jsx?)$/.test(name) ? [full] : [];
  });
}

describe("no hard-coded colours outside the theme", () => {
  it("src/ui and app use theme colours only", () => {
    const offenders: string[] = [];
    for (const file of [...files(path.join(root, "src/ui")), ...files(path.join(root, "app"))]) {
      const rel = path.relative(root, file);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/"#[0-9a-fA-F]{3,8}"|"(white|black)"|"rgba?\([^"]*\)"/g)) {
        if (EXCEPTIONS.some(([f, v]) => f === rel && v === m[0])) continue;
        offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
