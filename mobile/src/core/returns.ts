// Returns (FR-18): pick the source invoice, then its lines. The valuation, the frozen exchange rate and the reversals come
// from the shared return use-case; the phone only collects which lines and how many kg come back.
import { ReturnDoc, type CreateReturnInput } from "@backend/domain/entities/Return";
import { loadInvoiceView } from "./invoiceView";
import type { Phone } from "./phone";

export type ReturnKind = "sale" | "entry";
export type ReturnReason = "defect" | "wrong_quantity" | "wrong_order" | "other";

export const RETURN_REASON_LABEL: Record<ReturnReason, string> = {
  defect: "عيب",
  wrong_quantity: "كمية خاطئة",
  wrong_order: "طلب خاطئ",
  other: "أخرى",
};

export interface SourceInvoiceRow {
  id: string;
  number: string;
  date: string;
  total: number;
  currency: string;
}

export async function listSourceInvoices(
  phone: Phone,
  kind: ReturnKind,
  partyId: string,
): Promise<SourceInvoiceRow[]> {
  const page = await phone.repos.invoiceRepo.list(
    { partyId, type: kind, status: "active", limit: 50 },
    phone.context(),
  );
  return page.data.map((i) => ({
    id: i.id,
    number: i.number,
    date: i.date,
    total: Number(i.total),
    currency: i.currency,
  }));
}

export interface ReturnableLine {
  rollId: string;
  label: string;
  soldKg: number;
  pieces: number;
  pricePerKg: number;
}

export async function loadReturnableLines(
  phone: Phone,
  invoiceId: string,
): Promise<{ currency: string; lines: ReturnableLine[] } | null> {
  const view = await loadInvoiceView(phone, invoiceId);
  if (!view) return null;
  return {
    currency: view.invoice.currency,
    lines: view.lines.map((l) => ({
      rollId: l.rollId,
      label: `${l.fabric} · ${l.color} · ${l.rollNo}`,
      soldKg: l.quantityKg,
      pieces: l.pieces,
      pricePerKg: l.pricePerKg,
    })),
  };
}

export interface ReturnDraft {
  kind: ReturnKind;
  party: { id: string; name: string } | null;
  invoice: SourceInvoiceRow | null;
  currency: string;
  /** kg and pieces coming back, per roll (0 = not returned). */
  qty: Record<string, { kg: number; pieces: number }>;
  lines: ReturnableLine[];
  reason: ReturnReason;
}

export function emptyReturnDraft(kind: ReturnKind = "sale"): ReturnDraft {
  return {
    kind,
    party: null,
    invoice: null,
    currency: "USD",
    qty: {},
    lines: [],
    reason: "defect",
  };
}

export type ReturnProblem = "no-party" | "no-invoice" | "no-lines" | "over";

export const RETURN_PROBLEM_TEXT: Record<ReturnProblem, string> = {
  "no-party": "اختر الطرف",
  "no-invoice": "اختر الفاتورة الأصلية",
  "no-lines": "اكتب كمية مرتجعة لبند واحد على الأقل",
  over: "الكمية المرتجعة أكبر من المباعة في أحد البنود",
};

export function returnProblems(d: ReturnDraft): ReturnProblem[] {
  const out: ReturnProblem[] = [];
  if (!d.party) out.push("no-party");
  if (!d.invoice) out.push("no-invoice");
  const chosen = d.lines.filter((l) => (d.qty[l.rollId]?.kg ?? 0) > 0);
  if (chosen.length === 0) out.push("no-lines");
  if (chosen.some((l) => (d.qty[l.rollId]?.kg ?? 0) > l.soldKg)) out.push("over");
  return out;
}

export function toReturnInput(d: ReturnDraft, date: string): CreateReturnInput {
  if (!d.party || !d.invoice) throw new Error("incomplete return draft");
  return {
    kind: d.kind,
    date,
    partyId: d.party.id,
    originalInvoiceId: d.invoice.id,
    reason: d.reason,
    currency: d.currency,
    lines: d.lines
      .filter((l) => (d.qty[l.rollId]?.kg ?? 0) > 0)
      .map((l) => ({
        rollId: l.rollId,
        quantityKg: d.qty[l.rollId]!.kg,
        pieces: d.qty[l.rollId]!.pieces,
        pricePerKg: l.pricePerKg,
      })),
  } as CreateReturnInput;
}

export interface ReturnListRow {
  id: string;
  number: string;
  kind: string;
  date: string;
  status: string;
  version: number;
  total: number;
  currency: string;
}

export async function listReturns(phone: Phone): Promise<ReturnListRow[]> {
  const page = await phone.repos.returnRepo.list({ limit: 50 } as never, phone.context());
  return page.data.map((r) => ({
    id: r.id,
    number: r.number,
    kind: r.kind,
    date: r.date,
    status: r.status,
    version: r.version,
    total: ReturnDoc.reconstitute(r).amount,
    currency: r.currency,
  }));
}
