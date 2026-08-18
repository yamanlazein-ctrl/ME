/**
 * Note parser — extracts structured fields from a `note` string that was
 * built by the entry form (invoices.entry.new.tsx). The form concatenates
 * reference / source / machine / chromaj / gsm / count / draw / grossKg
 * with a known separator. Anything that doesn't match a known key is
 * returned as `freeText` so the printable "ملاحظات" only shows real
 * free-form notes (per the user's spec).
 *
 * This avoids a database schema change while still presenting each
 * structured field in its own column.
 */

export type ParsedLineNote = {
  reference: string;
  source: string;
  machineNo: string;
  chromaj: string;
  gsm: string;
  length: string;
  count: string;
  draw: string;
  grossKg: string;
  freeText: string;
};

const EMPTY: ParsedLineNote = {
  reference: "",
  source: "",
  machineNo: "",
  chromaj: "",
  gsm: "",
  length: "",
  count: "",
  draw: "",
  grossKg: "",
  freeText: "",
};

/** Field keys that the entry form writes, in their Arabic labels.
 *  Order matters only for parsing (longer keys first to avoid prefix collisions). */
const FIELD_KEYS: Array<{ key: keyof Omit<ParsedLineNote, "freeText">; pattern: RegExp }> = [
  { key: "reference", pattern: /مرجعية\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "reference", pattern: /المرجع\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "source", pattern: /مصدر\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "machineNo", pattern: /رقم\s*الماكينة\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "machineNo", pattern: /رقم الماكينة\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "chromaj", pattern: /كرماج\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "chromaj", pattern: /كروماج\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "gsm", pattern: /GSM\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "length", pattern: /المد\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "count", pattern: /العدد\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "draw", pattern: /السحب\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "grossKg", pattern: /وزن\s*قائم\s*:\s*([^•]+?)(?=\s*•|$)/ },
];

/** Parse a single line note. Returns empty strings when nothing matches. */
export function parseLineNote(raw: string | null | undefined): ParsedLineNote {
  if (!raw) return { ...EMPTY };
  const out: ParsedLineNote = { ...EMPTY };
  let working = raw.trim();

  for (const { key, pattern } of FIELD_KEYS) {
    const m = working.match(pattern);
    if (m && m[1]) {
      const val = m[1].trim();
      // First match wins; subsequent matches are ignored for the same key.
      if (!out[key]) out[key] = val;
      // Remove the matched chunk so it doesn't bleed into freeText.
      working = working.replace(m[0], "").trim();
    }
  }

  // Anything left in `working` is the real free text.
  out.freeText = working
    .replace(/^[•\s]+|[•\s]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return out;
}

/** Has the line note any structured data? */
export function hasStructuredNote(parsed: ParsedLineNote): boolean {
  return (
    !!parsed.reference ||
    !!parsed.source ||
    !!parsed.machineNo ||
    !!parsed.chromaj ||
    !!parsed.gsm ||
    !!parsed.length ||
    !!parsed.count ||
    !!parsed.draw ||
    !!parsed.grossKg
  );
}

/** Parse a top-level invoice.notes (which contains المرجع + طريقة الدفع) */
export type ParsedInvoiceNotes = {
  reference: string;
  paymentMethod: string;
  freeText: string;
};

const INVOICE_NOTE_KEYS: Array<{ key: keyof Omit<ParsedInvoiceNotes, "freeText">; pattern: RegExp }> = [
  { key: "reference", pattern: /المرجع\s*:\s*([^•]+?)(?=\s*•|$)/ },
  { key: "paymentMethod", pattern: /طريقة\s*الدفع\s*:\s*([^•]+?)(?=\s*•|$)/ },
];

export function parseInvoiceNotes(raw: string | null | undefined): ParsedInvoiceNotes {
  if (!raw) return { reference: "", paymentMethod: "", freeText: "" };
  const out: ParsedInvoiceNotes = { reference: "", paymentMethod: "", freeText: "" };
  let working = raw.trim();

  for (const { key, pattern } of INVOICE_NOTE_KEYS) {
    const m = working.match(pattern);
    if (m && m[1]) {
      const val = m[1].trim();
      if (!out[key]) out[key] = val;
      working = working.replace(m[0], "").trim();
    }
  }

  out.freeText = working
    .replace(/^[•\s]+|[•\s]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return out;
}
