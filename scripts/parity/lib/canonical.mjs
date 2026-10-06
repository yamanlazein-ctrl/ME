/**
 * Canonical form of one parity run (specs/001-desktop-sqlite-engine T051, contracts: "UUIDs mapped
 * through natural keys and creation order, timestamps compared as instants, money compared exactly").
 *
 * Two runs of the same scenarios on two engines create the same entities in the same order but with
 * different random UUIDs and wall-clock times. Canonicalization makes them comparable:
 *   - UUIDs → labels: first by order of appearance in the API transcript (the scenario's own creation
 *     order), then, for UUIDs the API never showed (internal rows), by each table's rows sorted on
 *     their already-labelled content — identical on both engines;
 *   - timestamps → "<ts>" (null-ness compared, wall time not). Order effects are still compared:
 *     every API list keeps its row order, so created_at sequencing and keyset paging show up there.
 *     (A global rank is not engine-stable: the API carries ms Dates, the tables µs text, and which
 *     of those coincide depends on the clock — an artefact, not behavior.)
 *   - money/text/numbers → exact values.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const TS_ANY = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)/g;
/**
 * Values that are random BY DESIGN (salts, IVs, AEAD output): compared for presence only.
 * table → columns; for the API transcript, object keys.
 */
const RANDOM_COLUMNS = { secrets: ["iv", "ciphertext", "auth_tag"], users: ["password_hash", "pin_hash"] };
const RANDOM_KEYS = new Set(["passwordHash", "pinHash"]);
const TS_PG = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/;

/**
 * Lists of dated records order same-date rows by (created_at, id). Rows of ONE transaction share
 * created_at, so their relative order — and the seq / runningBalance derived from it — follows random
 * UUIDs and differs run to run on EITHER engine. Within each run of same-date rows: sort by content
 * (UUIDs masked), mask seq and every runningBalance but the last. Day order and amounts stay compared.
 */
function normalizeTies(v) {
  if (Array.isArray(v)) {
    const out = v.map(normalizeTies);
    const dated = out.length > 1 && out.every((x) => x && typeof x === "object" && !Array.isArray(x) && "date" in x && "id" in x);
    if (!dated) return out;
    const key = (x) => JSON.stringify(x, (k, val) => (k === "seq" || k === "runningBalance" ? undefined : typeof val === "string" ? val.replace(UUID_ANY, "U") : val));
    const res = [];
    for (let i = 0; i < out.length; ) {
      let j = i + 1;
      while (j < out.length && out[j].date === out[i].date) j++;
      const group = out.slice(i, j);
      if (group.length > 1) {
        const last = group.at(-1).runningBalance;
        group.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
        group.forEach((x, n) => {
          if ("seq" in x) x.seq = "<tied>";
          if ("runningBalance" in x) x.runningBalance = n === group.length - 1 ? last : "<tied>";
        });
      }
      res.push(...group);
      i = j;
    }
    return res;
  }
  if (v && typeof v === "object") {
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, RANDOM_KEYS.has(k) && x != null ? "<random>" : normalizeTies(x)]));
    // Statement entry lines are read with NO ORDER BY on either engine: PG returns them in
    // plan order, which is not defined behavior — compared as an unordered set (allowed delta AD-LINES).
    if (Array.isArray(o.lines) && "referenceType" in o) {
      const k = (x) => JSON.stringify(x, (_, val) => (typeof val === "string" ? val.replace(UUID_ANY, "U") : val));
      o.lines = [...o.lines].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
    }
    // The inventory count sheet is ordered by roll id (identical rule on both engines; canonical
    // lowercase uuid text sorts like PG's uuid), and ids are random per run: compare by roll number.
    if (Array.isArray(o.lines) && o.lines.length > 1 && o.lines.every((l) => l && "bookKg" in l && "rollNo" in l)) {
      o.lines = [...o.lines].sort((a, b) => (a.rollNo < b.rollNo ? -1 : a.rollNo > b.rollNo ? 1 : 0));
    }
    return o;
  }
  return v;
}

/** Document numbers handed to parallel requests (recorded outcomes): one equivalence class. */
function parallelNumbers(transcript) {
  const out = new Set();
  for (const steps of Object.values(transcript)) {
    for (const s of Array.isArray(steps) ? steps : []) for (const n of s?.recorded?.numbers ?? []) out.add(n);
  }
  return out;
}

function maskNumbers(v, nums) {
  if (!nums.size) return v;
  if (typeof v === "string") {
    let s = v;
    for (const n of nums) s = s.split(n).join("<parallel-number>");
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => maskNumbers(x, nums));
  // the recorded outcome itself keeps its exact numbers (compared as is)
  if (v && typeof v === "object") return "recorded" in v ? v : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskNumbers(x, nums)]));
  return v;
}

export function canonicalize(run) {
  // Which of several IDENTICAL parallel requests received which document number is timing, on
  // either engine (PG: created_at is the transaction start, the number comes later under a lock).
  // The outcome — the set of numbers, unique and gapless — is recorded and compared separately.
  const nums = parallelNumbers(run.transcript);
  run = { transcript: maskNumbers(run.transcript, nums), tables: maskNumbers(run.tables, nums) };
  const tablesIn = {};
  for (const [t, rows] of Object.entries(run.tables)) {
    const rnd = RANDOM_COLUMNS[t] ?? [];
    // Parallel requests (keys tagged parity-conc-): which key won which document is timing, on
    // either engine; the payloads are identical, so the rows compare as a set with the key masked.
    const conc = (x) => (typeof x === "string" && x.startsWith("parity-conc-") ? "<parallel-request>" : x);
    tablesIn[t] = rows.map((r) => {
      const row = normalizeTies(Object.fromEntries(Object.entries(r).map(([k, x]) => [k, rnd.includes(k) && x != null ? "<random>" : conc(x)])));
      // A row written by one of several identical parallel requests: its insertion counter (serial
      // id, outbox seq) and the stock it saw (payload remainingKg) follow commit order — timing.
      if (!JSON.stringify(row).includes("<parallel-")) return row;
      const mask = (v) => {
        if (Array.isArray(v)) return v.map(mask);
        if (v && typeof v === "object") {
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(remainingKg|remaining_kg|remainingPieces|remaining_pieces)$/.test(k) ? "<commit-order>" : mask(x)]));
        }
        return v;
      };
      const out = mask(row);
      for (const k of ["id", "seq", "received_seq"]) if (typeof out[k] === "number") out[k] = "<commit-order>";
      return out;
    });
  }
  run = { transcript: normalizeTies(run.transcript), tables: tablesIn };
  // UUIDs that exist ONLY in rows written by identical parallel requests (those invoices, their
  // lines, operations…) are interchangeable: one shared label. Shared references (tenant, party,
  // roll) also appear in other rows and keep their own labels.
  const uuidsIn = (v, set) => {
    if (typeof v === "string") for (const m of v.match(UUID_ANY) ?? []) set.add(m.toLowerCase());
    else if (Array.isArray(v)) v.forEach((x) => uuidsIn(x, set));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => uuidsIn(x, set));
    return set;
  };
  // flagged = written by a parallel request, or referencing (transitively) a row that was
  const allRows = Object.values(tablesIn).flat();
  const flagged = new Set(allRows.filter((r) => JSON.stringify(r).includes("<parallel-")));
  for (let grew = true; grew; ) {
    grew = false;
    const ids = new Set([...flagged].map((r) => (typeof r.id === "string" ? r.id.toLowerCase() : null)).filter(Boolean));
    for (const r of allRows) {
      if (flagged.has(r)) continue;
      const refs = uuidsIn(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id")), new Set());
      if ([...refs].some((u) => ids.has(u))) {
        flagged.add(r);
        grew = true;
      }
    }
  }
  const inParallel = new Set();
  const elsewhere = new Set();
  for (const r of allRows) uuidsIn(r, flagged.has(r) ? inParallel : elsewhere);
  uuidsIn(run.transcript, elsewhere);
  const parallelOnly = new Set([...inParallel].filter((u) => !elsewhere.has(u)));
  const labels = new Map();
  for (const u of parallelOnly) labels.set(u, "<parallel-entity>");
  const label = (u) => {
    const k = u.toLowerCase();
    if (!labels.has(k)) labels.set(k, `#${String(labels.size + 1).padStart(5, "0")}`);
    return labels.get(k);
  };
  // 1. API transcript: deterministic traversal (sorted keys) assigns labels in creation order
  const walk = (v) => {
    if (typeof v === "string") for (const m of v.match(UUID_ANY) ?? []) label(m);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const k of Object.keys(v).sort()) walk(v[k]);
  };
  walk(run.transcript);
  // 2. tables: rows sorted on content with known labels; unseen UUIDs labelled in that order
  const tables = run.tables;
  const relabel = (v, unknown) => {
    if (typeof v === "string" && UUID.test(v)) return labels.get(v.toLowerCase()) ?? unknown;
    if (Array.isArray(v)) return v.map((x) => relabel(x, unknown));
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, relabel(v[k], unknown)]));
    return v;
  };
  const tsKey = (v) => (typeof v === "string" && (TS.test(v) || TS_PG.test(v)) ? "<ts>" : v);
  for (let pass = 0; pass < 3; pass++) {
    for (const t of Object.keys(tables).sort()) {
      const sorted = [...tables[t]].sort((a, b) => {
        const ka = JSON.stringify(relabel(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, tsKey(v)])), "?"));
        const kb = JSON.stringify(relabel(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, tsKey(v)])), "?"));
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      for (const row of sorted) for (const k of Object.keys(row).sort()) if (typeof row[k] === "string" && UUID.test(row[k])) label(row[k]);
    }
  }
  // 3. timestamps → rank in the run
  const allTs = new Set();
  const collectTs = (v) => {
    if (typeof v === "string" && (TS.test(v) || TS_PG.test(v))) allTs.add(instant(v));
    else if (Array.isArray(v)) v.forEach(collectTs);
    else if (v && typeof v === "object") Object.values(v).forEach(collectTs);
  };
  collectTs(run.transcript);
  collectTs(tables);
  const ranks = new Map([...allTs].sort().map((t, i) => [t, `<ts ${String(i + 1).padStart(5, "0")}>`]));
  // References built from a UUID's first 8 hex digits (e.g. count adjustments "CNT-2026-4b82fc1c")
  const byPrefix = new Map([...labels].map(([u, l]) => [u.slice(0, 8), l]));
  const prefixRef = (s) => s.replace(/\b([A-Z]{2,4}-\d{4}-)([0-9a-f]{8})\b/g, (all, head, hex) => (byPrefix.has(hex) ? `${head}${byPrefix.get(hex)}` : all));
  const finish = (v) => {
    if (typeof v === "string" && UUID.test(v)) return labels.get(v.toLowerCase()) ?? "<uuid?>";
    if (typeof v === "string" && /\b[A-Z]{2,4}-\d{4}-[0-9a-f]{8}\b/.test(v)) v = prefixRef(v);
    if (typeof v === "string" && (TS.test(v) || TS_PG.test(v))) return "<ts>";
    if (typeof v === "string") return v.replace(UUID_ANY, (m) => labels.get(m.toLowerCase()) ?? "<uuid?>").replace(TS_ANY, "<ts>");
    if (Array.isArray(v)) return v.map(finish);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, finish(v[k])]));
    return v;
  };
  const outTables = {};
  for (const t of Object.keys(tables).sort()) {
    outTables[t] = tables[t].map(finish).sort((a, b) => {
      const ka = JSON.stringify(a);
      const kb = JSON.stringify(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  return { transcript: finish(run.transcript), tables: outTables };
}

/** Any timestamp text → UTC instant with µs ("2026-10-04T09:35:01.123400Z"). */
function instant(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(s);
  if (!m) return s;
  const [, d, hh, mm, ss, frac = "", tz] = m;
  let offMin = 0;
  if (tz !== "Z") {
    const t = /^([+-])(\d{2}):?(\d{2})?$/.exec(tz);
    offMin = (t[1] === "-" ? -1 : 1) * (Number(t[2]) * 60 + Number(t[3] ?? 0));
  }
  const ms = Date.parse(`${d}T${hh}:${mm}:${ss}Z`) - offMin * 60000;
  return `${new Date(ms).toISOString().slice(0, 19)}.${frac.padEnd(6, "0").slice(0, 6)}Z`;
}
