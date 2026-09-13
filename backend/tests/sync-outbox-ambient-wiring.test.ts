import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * F-07 structural guard: a sync route's business write must be able to join the
 * SAME transaction as its outbox insert.
 *
 * The defect this locks down (reproduced live on PUT /api/company/profile, and
 * present in the ledger / cashbox / statement-settle / settings routes): the
 * route opens `withTenantTx(...)` around "business use-case + enqueue", but the
 * business repository was constructed with the RAW pool handle. Its statements
 * therefore ran on a SECOND pooled connection and committed independently, so a
 * failed outbox insert rolled back the outbox row but not the business write —
 * a durable local change with no sync unit, invisible to every repair path.
 *
 * Two ways a repository can be transaction-correct here:
 *   1. it is wired with the ambient proxy (`new PostgresXRepository(dbx)`), so
 *      `this.db.*` runs on the route's transaction; or
 *   2. it opens its transaction through `withTenantTx`, which now JOINS an
 *      active ambient transaction as a savepoint (see drizzle.ts).
 * Anything else silently forks.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const ROUTES_DIR = path.join(SRC, "presentation", "routes");
const SERVER_PATH = path.join(SRC, "presentation", "server.ts");
const CONTAINER_PATH = path.join(SRC, "infrastructure", "di", "container.ts");
const REPOS_DIR = path.join(SRC, "infrastructure", "repositories");

/** Text inside a balanced `(`…`)` starting at `openIdx` (which must be `(`). */
function balanced(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1);
}

/** Text inside a balanced `{`…`}` starting at `openIdx` (which must be `{`). */
function balancedBrace(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1);
}

/**
 * Body of the `withTenantTx` work callback. Routes pass a named closure
 * (`withTenantTx(c.tenantId, runCreate)`), so the repositories live in that
 * closure's definition, not inside the call's parentheses — resolve the
 * reference instead of looking at the call site.
 */
function transactionBody(fileSrc: string, callArgs: string): string {
  const args = splitArgs(callArgs);
  const cb = args[args.length - 1] ?? "";
  const ident = /^[A-Za-z_$][\w$]*$/.exec(cb.trim());
  if (!ident) return cb; // inline arrow: the argument text IS the body
  const name = ident[0];
  const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[\\w$]+)\\s*=>`);
  const m = decl.exec(fileSrc);
  if (!m) return "";
  const braceIdx = fileSrc.indexOf("{", m.index + m[0].length - 1);
  if (braceIdx === -1) return "";
  return balancedBrace(fileSrc, braceIdx);
}

/** Split a call-argument string on top-level commas. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of args) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Route file → exported register function name. */
function registerFnName(file: string): string | null {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
  const m = /export\s+function\s+(register\w+)\s*\(/.exec(src);
  return m ? m[1] : null;
}

/** register fn name → [paramName] in declaration order. */
function registerFnParams(fnName: string): string[] {
  for (const f of fs.readdirSync(ROUTES_DIR)) {
    if (!f.endsWith(".route.ts")) continue;
    const src = fs.readFileSync(path.join(ROUTES_DIR, f), "utf8");
    const m = new RegExp(`export\\s+function\\s+${fnName}\\s*\\(`).exec(src);
    if (!m) continue;
    const args = balanced(src, src.indexOf("(", m.index));
    return splitArgs(args).map((a) => a.replace(/[\s\S]*?(\w+)\s*:[\s\S]*/, "$1").trim());
  }
  return [];
}

/** Local param name → container field name, from server.ts registration calls. */
function paramToContainerField(fnName: string): Record<string, string> {
  const src = fs.readFileSync(SERVER_PATH, "utf8");
  const callIdx = src.indexOf(`${fnName}(`);
  if (callIdx === -1) return {};
  const args = splitArgs(balanced(src, src.indexOf("(", callIdx)));
  const params = registerFnParams(fnName);
  const map: Record<string, string> = {};
  // args[0] is the router; params[0] is `router` too.
  for (let i = 0; i < args.length && i < params.length; i++) {
    const field = /container\.(\w+)/.exec(args[i]);
    if (field) map[params[i]] = field[1];
  }
  return map;
}

/** container field → repository class name (`const x = new PostgresYRepo(handle)`). */
function containerWiring(): Record<string, { cls: string; handle: string }> {
  const src = fs.readFileSync(CONTAINER_PATH, "utf8");
  const out: Record<string, { cls: string; handle: string }> = {};
  const re = /const\s+(\w+)\s*=\s*new\s+(\w+)\s*\(\s*(\w+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out[m[1]] = { cls: m[2], handle: m[3] };
  return out;
}

function repoSourcePath(cls: string): string {
  const p = path.join(REPOS_DIR, `${cls}.ts`);
  return fs.existsSync(p) ? p : "";
}

/**
 * Repositories that appear inside a tenant transaction but are deliberately NOT
 * ambient-wired, because their writes are fire-and-forget side records that
 * must never be able to abort a business transaction. Each entry needs a
 * reason; an unexplained entry fails this guard.
 */
const FIRE_AND_FORGET: Record<string, string> = {
  auditRepo:
    "audit rows are fire-and-forget side records (container.ts: 'Deliberately NOT proxied: auditRepo'). " +
    "They have no sync unit, so an audit failure must never roll back the business write.",
};

describe("F-07 wiring — sync routes must let their business write join the outbox transaction", () => {
  const container = containerWiring();
  const candidates: Array<{ file: string; fields: string[] }> = [];

  for (const file of fs.readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".route.ts")) continue;
    const src = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!src.includes("withTenantTx(") || !src.includes("enqueue")) continue;
    const fn = registerFnName(file);
    const map = fn ? paramToContainerField(fn) : {};
    const fields = new Set<string>();
    // Every `withTenantTx(` region: the repositories referenced inside it are
    // the ones whose writes must share the transaction.
    let idx = src.indexOf("withTenantTx(");
    while (idx !== -1) {
      const open = src.indexOf("(", idx);
      const region = transactionBody(src, balanced(src, open));
      for (const m of region.matchAll(/container\.(\w+)/g)) fields.add(m[1]);
      for (const [param, field] of Object.entries(map)) {
        if (new RegExp(`\\b${param}\\b`).test(region)) fields.add(field);
      }
      idx = src.indexOf("withTenantTx(", idx + 1);
    }
    candidates.push({ file, fields: [...fields] });
  }

  it("finds the sync routes that wrap a business write in a tenant transaction", () => {
    expect(candidates.length).toBeGreaterThanOrEqual(8);
  });

  it("every repository used inside those transactions is ambient-aware", () => {
    const bad: string[] = [];
    for (const { file, fields } of candidates) {
      if (fields.length === 0) bad.push(`${file}: no repository resolved inside withTenantTx (parser drift)`);
      for (const field of fields) {
        if (field.startsWith("sync")) continue; // outbox/inbox: already dbx-wired by design
        if (FIRE_AND_FORGET[field]) continue; // documented fire-and-forget side record
        const wire = container[field];
        if (!wire) {
          bad.push(`${file}: container.${field} has no constructor wiring`);
          continue;
        }
        if (wire.handle === "dbx") continue; // (1) ambient proxy
        const repoPath = repoSourcePath(wire.cls);
        const repo = repoPath ? fs.readFileSync(repoPath, "utf8") : "";
        // (2) opens its transaction through withTenantTx → joins as a savepoint.
        if (/\bwithTenantTx\s*\(/.test(repo)) continue;
        bad.push(
          `${file}: ${wire.cls} is wired with \`${wire.handle}\` and never joins an ambient transaction — ` +
            "its writes would commit outside the route's transaction",
        );
      }
    }
    expect(bad, bad.join("; ")).toEqual([]);
  });

  it("fire-and-forget exceptions carry a reason", () => {
    for (const [field, reason] of Object.entries(FIRE_AND_FORGET)) {
      expect(reason.trim().length, `${field} needs a documented reason`).toBeGreaterThan(20);
    }
  });

  it("the company profile route enqueues inside the tenant transaction (regression)", () => {    const src = fs.readFileSync(path.join(ROUTES_DIR, "company.route.ts"), "utf8");
    const putIdx = src.indexOf('"/api/company/profile"');
    expect(putIdx, "PUT /api/company/profile must exist").toBeGreaterThan(-1);
    const region = src.slice(putIdx);
    expect(region).toContain("withTenantTx(");
    // A swallowed enqueue error is what made the profile fork silently.
    expect(
      /catch\s*\([^)]*\)\s*\{\s*logger\.\w+\([^)]*\)\s*;?\s*\}/.test(
        region.slice(0, region.indexOf("router.post(")),
      ),
      "the profile route must not swallow an enqueue failure",
    ).toBe(false);
  });
});
