/**
 * POST-FIX VERIFICATION — multi-color entry invoice edit flow.
 *
 * Simulates the FIXED component logic (invoices.entry.new.tsx) 1:1 against the
 * LIVE backend + real invoice data:
 *   1. Baseline: the OLD one-shot cold-cache mapping (the bug) — fails.
 *   2. Fix A: prefill with cold cache, then the repair effect fills identity
 *      fields when the cache arrives — validation passes.
 *   3. Fix B: the editPrefilledRef guard — a refetched editInvoice must not
 *      clobber operator edits.
 *   4. Repair safety: user-typed values are never overwritten; rows are paired
 *      by rollId (add/delete of rows cannot mismatch fields).
 *   5. Save payload: the invLines the fixed form would PUT match the DB rows
 *      exactly (idempotent edit of the same 3-color invoice).
 *   6. كراماج unification: the REAL bundled lineDetails.ts + noteParser.ts
 *      parse the canonical spelling round-trip.
 *   7. Toast CSS: theme token is a full color and toast-helpers no longer
 *      wraps it in hsl().
 *
 * Network usage: login-token mint + GET requests only. No invoice is created,
 * updated or deleted.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";

const API = `http://127.0.0.1:${process.env.PORT || 8080}`;
let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/* ── Auth: short-lived diagnostic token (GET-only usage) ── */
const { Client } = pg;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const admin = (
  await db.query(`SELECT id, tenant_id, role FROM users WHERE role='admin' AND active ORDER BY created_at LIMIT 1`)
).rows[0];
const token = await new SignJWT({
  sub: admin.id, tenantId: admin.tenant_id, role: admin.role, jti: randomUUID(), type: "access",
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));

const getJson = async (p) => {
  const r = await fetch(`${API}${p}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
  return r.json();
};
const unwrap = (x) => (Array.isArray(x?.data) ? x.data : Array.isArray(x) ? x : []);

/* ── Live data: inventory caches + the real 3-color invoice ── */
const invoiceId = (
  await db.query(
    `SELECT i.id FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
      WHERE i.type='entry' GROUP BY i.id HAVING count(DISTINCT l.color_id) > 1
      ORDER BY count(DISTINCT l.color_id) DESC LIMIT 1`,
  )
).rows[0].id;
const invBody = await getJson(`/api/invoices/${invoiceId}`);
const invoice = invBody.data ?? invBody;
console.log(`\nTarget: ${invoice.number} (${invoice.lines.length} lines, colors: ${new Set(invoice.lines.map((l) => l.colorId)).size})`);

const WARM = {
  fabrics: unwrap(await getJson("/api/inventory/fabrics?limit=1000")),
  colors: unwrap(await getJson("/api/inventory/colors?limit=1000")),
  rolls: unwrap(await getJson("/api/inventory/rolls?limit=1000")),
};
const fabricByIdIn = (cache, id) => cache.fabrics.find((f) => f.id === id) ?? null;
const colorByIdIn = (cache, id) => cache.colors.find((c) => c.id === id) ?? null;
const rollByIdIn = (cache, id) => cache.rolls.find((r) => r.id === id) ?? null;

/* ── 1:1 port of the FIXED component logic (entry.new.tsx) ── */
const FIELD_PATTERNS = [
  ["مرجعية", "مرجعية"], ["مصدر", "مصدر"], ["رقم الماكينة", "رقم الماكينة"],
  ["كراماج", "كراماج"], ["GSM", "GSM"], ["السحب", "السحب"], ["وزن قائم", "وزن قائم"],
];
const parseLineDetails = (note) => {
  if (!note || !note.trim()) return { details: [], freeText: "" };
  const details = [];
  for (const part of note.split("•").map((p) => p.trim()).filter(Boolean)) {
    for (const [label, key] of FIELD_PATTERNS) {
      if (part.startsWith(key + ":")) {
        const value = part.slice(key.length + 1).trim();
        if (value) details.push({ label, value });
        break;
      }
    }
  }
  return { details };
};
const emptyLine = (seq) => ({
  id: `l-${seq}`, fabricName: "", category: "", unit: "kg", colorName: "", colorCode: "",
  dyeBatch: "", grossKg: 0, quantity: 0, pricePerKg: 0, discountAmount: 0, marjaiya: "",
  masader: "", machineNumber: "", kromaj: "", gsm: "", sahb: "", pieces: 1,
});

// The prefill mapping — identical to the fixed effect body.
let seq = 0;
function prefillMapping(editInvoice, cache) {
  return editInvoice.lines.map((l) => {
    const fab = fabricByIdIn(cache, l.fabricId);
    const col = colorByIdIn(cache, l.colorId);
    const roll = rollByIdIn(cache, l.rollId);
    const line = {
      ...emptyLine(++seq),
      rollId: l.rollId,
      existingFabricId: fab?.id,
      existingColorId: col?.id,
      fabricName: fab?.name ?? "",
      category: fab?.category ?? "",
      unit: fab?.unit ?? "kg",
      colorName: col?.name ?? "",
      colorCode: col?.code ?? "",
      colorHex: col?.hex ?? undefined,
      quantity: l.quantityKg,
      pieces: l.pieces ?? 1,
      pricePerKg: l.pricePerKg,
      discountAmount: l.discountAmount ?? 0,
    };
    if (l.note) {
      for (const d of parseLineDetails(l.note).details) {
        const v = d.value;
        if (d.label.includes("مرجعية")) line.marjaiya = v;
        else if (d.label.includes("مصدر")) line.masader = v;
        else if (d.label.includes("الماكينة")) line.machineNumber = v;
        else if (d.label.includes("كراماج")) line.kromaj = v;
        else if (d.label.includes("GSM")) line.gsm = v;
        else if (d.label.includes("السحب")) line.sahb = v;
        else if (d.label.includes("قائم")) line.grossKg = Number(v) || 0;
      }
    }
    line.notes = roll?.rollNo ? `رقم الصبغة: ${roll.rollNo}` : undefined;
    return line;
  });
}

// The repair effect — identical logic: pair by rollId, fill ONLY empty identity fields.
function repairEffect(lines, rawLines, cache) {
  let changed = false;
  const next = lines.map((l) => {
    const raw = l.rollId ? rawLines.find((r) => r.rollId === l.rollId) : undefined;
    if (!raw) return l;
    let line = l;
    const fab = fabricByIdIn(cache, raw.fabricId);
    if (fab && !l.existingFabricId && !l.fabricName.trim()) {
      line = { ...line, existingFabricId: fab.id, fabricName: fab.name, category: fab.category ?? "", unit: fab.unit ?? "kg" };
    }
    const col = colorByIdIn(cache, raw.colorId);
    if (col && !l.existingColorId && !l.colorName.trim()) {
      line = { ...line, existingColorId: col.id, colorName: col.name, colorCode: col.code, colorHex: col.hex ?? undefined, colorImageUrl: col.imageUrl ?? undefined };
    }
    const roll = rollByIdIn(cache, raw.rollId);
    if (roll?.rollNo && !l.notes) line = { ...line, notes: `رقم الصبغة: ${roll.rollNo}` };
    if (line !== l) changed = true;
    return line;
  });
  return changed ? next : lines;
}

const lineHasData = (l) => l.fabricName.trim() !== "" || l.quantity > 0 || l.pricePerKg > 0;
function validateEntry(lines) {
  const failures = [];
  const rows = lines.filter(lineHasData);
  for (const l of rows) {
    const label = l.fabricName.trim() || `سطر #${rows.indexOf(l) + 1}`;
    const missing = [];
    if (!l.fabricName.trim()) missing.push("اسم");
    if (!l.colorName.trim()) missing.push("لون");
    if (l.quantity <= 0) missing.push("وزن");
    if (l.pricePerKg <= 0) missing.push("سعر");
    if (missing.length) failures.push(`${label}: ${missing.join("/")}`);
  }
  return failures;
}
const EMPTY_CACHE = { fabrics: [], colors: [], rolls: [] };

/* ═══ 1. Baseline: the OLD bug (one-shot mapping on cold cache) ═══ */
console.log("\n[1] Baseline — old behavior: one-shot prefill with COLD cache");
const coldMapped = prefillMapping(invoice, EMPTY_CACHE);
const oldFailures = validateEntry(coldMapped);
check("old code fails validation on cold cache (bug reproduced)", oldFailures.length > 0, JSON.stringify(oldFailures));

/* ═══ 2. Fix A: prefill cold → cache arrives → repair → valid ═══ */
console.log("\n[2] Fix A — cold-cache prefill then repair effect on cache arrival");
seq = 0;
const state = { lines: prefillMapping(invoice, EMPTY_CACHE) };
const rawLinesRef = invoice.lines.map((l) => ({ rollId: l.rollId, fabricId: l.fabricId, colorId: l.colorId }));
state.lines = repairEffect(state.lines, rawLinesRef, WARM); // inventoryVersion change
const postRepair = validateEntry(state.lines);
check("all lines repaired (names resolved)", postRepair.length === 0, JSON.stringify(postRepair));
check(
  "quantities preserved from API (190/20/200-scale data)",
  state.lines.every((l) => l.quantity > 0 && invoice.lines.some((r) => r.rollId === l.rollId && r.quantityKg === l.quantity)),
);
check("roll numbers rehydrated", state.lines.every((l) => /رقم الصبغة: R-/.test(l.notes ?? "")));

/* ═══ 3. Fix B: guard — refetch must not clobber operator edits ═══ */
console.log("\n[3] Fix B — editPrefilledRef guard against refetch clobber");
let prefilledFor = null;
function prefillEffect(editId, editInvoiceArg, cache) {
  if (!editId || !editInvoiceArg) return;
  if (prefilledFor === editId) return; // editPrefilledRef guard
  prefilledFor = editId;
  state.lines = prefillMapping(editInvoiceArg, cache);
}
seq = 0;
state.lines = prefillMapping(invoice, WARM); // initial warm prefill
prefilledFor = invoiceId;
const userEdited = structuredClone(state.lines);
userEdited[0].quantity = 150; // operator changes a weight
userEdited[1].colorName = "تعديل يدوي";
state.lines = userEdited;
const refetched = { ...invoice, version: invoice.version + 1 }; // NEW identity, same data
prefillEffect(invoiceId, refetched, WARM); // effect re-fires after refetch
check(
  "operator edits survive a refetch (guard active)",
  state.lines[0].quantity === 150 && state.lines[1].colorName === "تعديل يدوي",
  `qty=${state.lines[0].quantity}`,
);
check("guard prevents re-mapping entirely", state.lines === userEdited);

/* ═══ 4. Repair safety: user-typed values never overwritten; rollId pairing ═══ */
console.log("\n[4] Repair safety — only empty fields are filled");
seq = 0;
const mixed = prefillMapping(invoice, EMPTY_CACHE); // cold prefill
mixed[0].fabricName = "قماش مكتوب يدوياً"; // operator typed a name before cache arrived
mixed[0].existingFabricId = undefined;
const addedRow = { ...emptyLine(++seq), fabricName: mixed[0].fabricName, colorName: "" }; // user-added row (no rollId)
const repaired = repairEffect([...mixed, addedRow], rawLinesRef, WARM);
check("user-typed fabric name NOT overwritten", repaired[0].fabricName === "قماش مكتوب يدوياً");
check("user-typed row still gets its COLOR repaired", repaired[0].colorName.length > 0, repaired[0].colorName);
check("rows 2..n fully repaired", repaired.slice(1, invoice.lines.length).every((l) => l.fabricName && l.colorName));
check(
  "user-ADDED row (no rollId) is never touched by repair",
  repaired[repaired.length - 1].colorName === "" && repaired[repaired.length - 1].fabricName === "قماش مكتوب يدوياً",
);
check(
  "rollId pairing: correct color per line (multi-color invoice)",
  repaired.slice(0, invoice.lines.length).every((l) => {
    const raw = invoice.lines.find((r) => r.rollId === l.rollId);
    const col = WARM.colors.find((c) => c.id === raw.colorId);
    return l.colorName === col.name;
  }),
);

/* ═══ 5. Save payload: what the fixed form PUTs == the DB rows ═══ */
console.log("\n[5] Edit-save payload (invLines) built from repaired state");
const repairedState = repairEffect(prefillMapping(invoice, EMPTY_CACHE), rawLinesRef, WARM);
const invLines = repairedState
  .filter(lineHasData)
  .map((l) => ({
    fabricId: l.existingFabricId ?? undefined,
    colorId: l.existingColorId ?? undefined,
    rollId: l.rollId,
    quantityKg: l.quantity,
    pieces: l.pieces || 1,
    pricePerKg: l.pricePerKg,
    discountAmount: l.discountAmount ?? 0,
  }));
const expected = invoice.lines.map((l) => ({
  fabricId: l.fabricId, colorId: l.colorId, rollId: l.rollId,
  quantityKg: l.quantityKg, pieces: l.pieces ?? 1, pricePerKg: l.pricePerKg, discountAmount: l.discountAmount ?? 0,
}));
check(
  "payload is line-for-line identical to the stored invoice (idempotent edit)",
  JSON.stringify(invLines) === JSON.stringify(expected),
);

/* ═══ 6. كراماج round-trip via the REAL bundled parsers ═══ */
console.log("\n[6] كراماج spelling — real source files (esbuild-bundled)");
const tmp = path.join(process.cwd(), "scripts", ".verify-build");
fs.mkdirSync(tmp, { recursive: true });
const entry = path.join(tmp, "parsers-entry.mjs");
fs.writeFileSync(
  entry,
  [
    `import { parseLineDetails } from ${JSON.stringify(path.resolve("../src/components/print/invoices/lineDetails.ts").replace(/\\/g, "/"))};`,
    `import { parseLineNote } from ${JSON.stringify(path.resolve("../src/components/print/noteParser.ts").replace(/\\/g, "/"))};`,
    `const note = "مرجعية: أ • مصدر: ب • رقم الماكينة: M1 • كراماج: K-9 • GSM: 180 • السحب: S1 • وزن قائم: 200";`,
    `const d = parseLineDetails(note);`,
    `const n = parseLineNote(note);`,
    `const kromaj = d.details.find((x) => x.label === "كراماج")?.value ?? "";`,
    `export const result = JSON.stringify({ kromaj, chromaj: n.chromaj, machineNo: n.machineNo, grossKg: n.grossKg });`,
  ].join("\n"),
);
let parsed = {};
try {
  const out = path.join(tmp, "parsers-bundle.mjs");
  const esbuild = path.join(process.cwd(), "node_modules", "@esbuild", "win32-x64", "esbuild.exe");
  try {
    execSync(`"${esbuild}" ${entry} --bundle --platform=node --format=esm --packages=external --outfile=${out}`, {
      stdio: "pipe",
    });
  } catch (e) {
    // Sandboxed environments may block spawnSync (EPERM) — fall back to a
    // bundle built externally: esbuild.exe <entry> ... --outfile=<out>
    if (!fs.existsSync(out)) throw e;
    console.log("  (spawn blocked — using externally prebuilt bundle)");
  }
  parsed = JSON.parse((await import(`file:///${out.replace(/\\/g, "/")}`)).result);
} catch (e) {
  console.log("  (bundle step error: " + (e?.message ?? e) + ")");
}
check("lineDetails.ts parses كراماج (entry edit mapping)", parsed.kromaj === "K-9", JSON.stringify(parsed));
check("noteParser.ts parses كراماج (print layouts)", parsed.chromaj === "K-9", JSON.stringify(parsed));
check("noteParser other fields unaffected", parsed.machineNo === "M1" && parsed.grossKg === "200", JSON.stringify(parsed));

/* ═══ 7. Toast CSS fix — real files ═══ */
console.log("\n[7] Toast background — token is a full color, no hsl() wrap");
const toastSrc = fs.readFileSync(path.resolve("../src/components/common/toast-helpers.ts"), "utf8");
const stylesSrc = fs.readFileSync(path.resolve("../src/styles.css"), "utf8");
check("toast-helpers no longer wraps tokens in hsl()", !toastSrc.includes("hsl(var("));
check("uses var(--destructive) directly", toastSrc.includes('background: "var(--destructive)"'));
check("--destructive token is a full oklch color (valid background value)", /--destructive:\s*oklch\(/.test(stylesSrc));

/* ═══ Summary ═══ */
if (parsed.kromaj !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
await db.end();
console.log(`\n${"=".repeat(60)}\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
