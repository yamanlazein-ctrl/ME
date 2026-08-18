/**
 * Parses the structured per-line note string produced by the entry form
 * into labeled detail fields for the print layout.
 */

export type LineDetail = { label: string; value: string };

const FIELD_PATTERNS: { label: string; key: string }[] = [
  { label: "مرجعية", key: "مرجعية" },
  { label: "مصدر", key: "مصدر" },
  { label: "رقم الماكينة", key: "رقم الماكينة" },
  { label: "كرماج", key: "كرماج" },
  { label: "GSM", key: "GSM" },
  { label: "العدد", key: "العدد" },
  { label: "السحب", key: "السحب" },
  { label: "وزن قائم", key: "وزن قائم" },
];

export function parseLineDetails(note?: string): {
  details: LineDetail[];
  freeText: string;
} {
  if (!note || !note.trim()) return { details: [], freeText: "" };
  const parts = note.split("•").map((p) => p.trim()).filter(Boolean);
  const details: LineDetail[] = [];
  const freeParts: string[] = [];
  for (const part of parts) {
    let matched = false;
    for (const f of FIELD_PATTERNS) {
      const prefix = f.key + ":";
      if (part.startsWith(prefix)) {
        const value = part.slice(prefix.length).trim();
        if (value) details.push({ label: f.label, value });
        matched = true;
        break;
      }
    }
    if (!matched) freeParts.push(part);
  }
  return { details, freeText: freeParts.join(" • ") };
}
