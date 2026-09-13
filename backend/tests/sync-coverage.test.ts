import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SYNC_COVERAGE } from "../src/application/use-cases/sync/syncCoverage.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(HERE, "..", "src", "presentation", "routes");
const MAT_PATH = path.join(
  HERE,
  "..",
  "src",
  "application",
  "use-cases",
  "sync",
  "syncMaterialize.ts",
);

/** All mutating endpoints declared in route files (incl. backtick paths). */
function collectMutations(): Array<{ file: string; method: string; route: string }> {
  const out: Array<{ file: string; method: string; route: string }> = [];
  for (const f of fs.readdirSync(ROUTES_DIR)) {
    if (!f.endsWith(".route.ts") || f === "sync.route.ts" || f === "health.route.ts") continue;
    const lines = fs.readFileSync(path.join(ROUTES_DIR, f), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const inline = lines[i].match(/router\.(post|patch|put|delete)\(\s*"([^"]+)"/);
      if (inline) {
        out.push({ file: f, method: inline[1].toUpperCase(), route: inline[2] });
        continue;
      }
      const multi = lines[i].match(/router\.(post|patch|put|delete)\(\s*$/);
      if (multi) {
        const next = lines[i + 1] || "";
        // Backtick paths built from a base (`${base}/:id/statement/settle`).
        if (next.includes(":id/statement/settle")) {
          out.push({ file: f, method: "POST", route: "/customers/:id/statement/settle" });
          out.push({ file: f, method: "POST", route: "/suppliers/:id/statement/settle" });
          continue;
        }
        const lit = next.match(/"([^"]+)"/) || next.match(/`([^`$]+)[^`]*`/);
        if (lit) out.push({ file: f, method: multi[1].toUpperCase(), route: lit[1] });
      }
    }
  }
  return out;
}

describe("sync coverage (SYNC-13) — every mutation is synced or explicitly exempt", () => {
  const mutations = collectMutations();

  it("collects a sane mutation inventory", () => {
    expect(mutations.length).toBeGreaterThan(50);
  });

  it("every mutating endpoint is registered in SYNC_COVERAGE", () => {
    const missing = mutations.filter((m) => !SYNC_COVERAGE[`${m.method} ${m.route}`]);
    expect(
      missing,
      `unregistered mutating endpoints (add a sync or exempt entry): ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });

  it("every registered sync entry enqueues in its route file", () => {
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(SYNC_COVERAGE)) {
      if (!("sync" in entry)) continue;
      const [method, route] = key.split(" ", 2);
      const holder = mutations.find((m) => m.method === method && m.route === route);
      if (!holder) {
        bad.push(`${key}: registry entry with no route`);
        continue;
      }
      const src = fs.readFileSync(path.join(ROUTES_DIR, holder.file), "utf8");
      if (!src.includes("enqueue")) bad.push(`${key}: no enqueue call in ${holder.file}`);
    }
    expect(bad, `sync entries without enqueue wiring: ${bad.join("; ")}`).toEqual([]);
  });

  it("every registered sync entry has a materialize branch", () => {
    const mat = fs.readFileSync(MAT_PATH, "utf8");
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(SYNC_COVERAGE)) {
      if (!("sync" in entry)) continue;
      const { entityType, operation } = entry.sync;
      // Grouped dispatch: `if (entityType === "cashbox")` fans out inside
      // materializeCashbox — the pair lives there, not in one condition.
      if (entityType === "cashbox") {
        const start = mat.indexOf("async function materializeCashbox");
        const end = mat.indexOf("async function materializeAdminSnapshot");
        const region = start >= 0 && end > start ? mat.slice(start, end) : "";
        if (!region.includes(`operation === "${operation}"`)) {
          bad.push(`${key}: no materialize branch for ${entityType}/${operation}`);
        }
        continue;
      }
      // Pair check: the entity and operation must appear in the SAME branch
      // condition — separate mentions (e.g. party/create + invoice/update)
      // must NOT satisfy party/update.
      const pair = new RegExp(
        `entityType === "${entityType}"[\\s\\S]{0,160}operation === "${operation}"` +
          `|operation === "${operation}"[\\s\\S]{0,160}entityType === "${entityType}"` +
          `|"${entityType}/${operation}"|"${entityType}"[^;]{0,60}"${operation}"`,
      );
      if (!pair.test(mat)) bad.push(`${key}: no materialize branch for ${entityType}/${operation}`);
    }
    expect(bad, `sync entries without materialize support: ${bad.join("; ")}`).toEqual([]);
  });

  it("exemptions carry non-empty reasons", () => {
    const bad = Object.entries(SYNC_COVERAGE).filter(
      ([, e]) => "exempt" in e && !(e as { exempt: string }).exempt.trim(),
    );
    expect(bad).toEqual([]);
  });
});
