import { lineHasData, type SaleLine } from "@/components/invoices/sale-types";
import type { Currency } from "@/domain/types";

const SALE_DRAFT_KEY = "erp.draft.sale.v1";

/**
 * The working state of a sale invoice, captured while the operator types.
 * Derived state (order prefill, conflict prompts, debt confirmation) is
 * deliberately absent — it is rebuilt from the server on arrival.
 */
export interface SaleDraft {
  savedAt: string;
  customerId: string;
  currency: Currency | "";
  lines: SaleLine[];
  paid: number | "";
  date: string;
  reference: string;
  notes: string;
}

export function saveSaleDraft(draft: Omit<SaleDraft, "savedAt">): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SALE_DRAFT_KEY, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
  } catch {
    // Storage full or blocked — losing the draft must never break the form.
  }
}

/**
 * A draft worth offering back. An empty form is not work in progress — without
 * this, discarding a draft would immediately be re-saved and offered again.
 */
export function saleDraftHasContent(draft: Omit<SaleDraft, "savedAt">): boolean {
  if (draft.customerId !== "" || draft.reference !== "" || draft.notes !== "") return true;
  if (Number(draft.paid) > 0) return true;
  return draft.lines.some(lineHasData);
}

export function loadSaleDraft(): SaleDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SALE_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SaleDraft>;
    if (!parsed || !Array.isArray(parsed.lines)) return null;
    return {
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
      customerId: parsed.customerId ?? "",
      currency: parsed.currency ?? "",
      lines: parsed.lines,
      paid: parsed.paid ?? "",
      date: parsed.date ?? "",
      reference: parsed.reference ?? "",
      notes: parsed.notes ?? "",
    };
  } catch {
    // Unreadable or corrupt — treat as no draft rather than breaking mount.
    return null;
  }
}

export function clearSaleDraft(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(SALE_DRAFT_KEY);
  } catch {
    // ignore
  }
}
