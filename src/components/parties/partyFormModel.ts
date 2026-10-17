import { is2dp } from "@/shared/utils/precision";
import type { PartyOpeningInput } from "@erp/shared";
import { localToday } from "@/lib/localDate";
import type { Currency } from "@/domain/types";
import type { PartyStatus, PaymentMethod, PaymentTerms } from "@/domain/entities/Party";

/** The party form's data model — pure, no React (kept out of PartyFormDialog.tsx so that file only
 * exports components; react-refresh/only-export-components). */
export type PartyKind = "supplier" | "customer";

export type SimpleParty = {
  id: string;
  code?: string;
  name: string;
  companyName?: string | null;
  commercialReg?: string | null;
  category?: string | null;
  salesRep?: string | null;
  phone?: string | null;
  mobile?: string | null;
  whatsapp?: string | null;
  altPhone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  openingBalance?: number;
  openingDate?: string | null;
  openingNote?: string | null;
  openingCurrency?: Currency | null;
  /** Edit only, and only when the opening balance changed → PUT …/:id/opening. */
  opening?: PartyOpeningInput;
  creditLimit?: number;
  currency?: Currency;
  paymentTerms?: PaymentTerms;
  paymentMethod?: PaymentMethod;
  defaultDiscount?: number;
  vat?: number;
  notes?: string | null;
  status?: PartyStatus;
  /** Edit only: the version the form was opened with (sent as expectedVersion). */
  version?: number;
};

export type OpeningDirection = PartyOpeningInput["direction"];
export type OpeningCurrency = PartyOpeningInput["currency"];

/** Positive SoT = "they owe us" for a customer, "we owe them" for a supplier. */
export const positiveDirection = (kind: PartyKind): OpeningDirection =>
  kind === "supplier" ? "we_owe_them" : "they_owe_us";

export type Draft = {
  code: string;
  name: string;
  companyName: string;
  commercialReg: string;
  category: string;
  salesRep: string;
  taxNumber: string;
  status: PartyStatus;
  phone: string;
  mobile: string;
  whatsapp: string;
  email: string;
  website: string;
  address: string;
  city: string;
  country: string;
  openingAmount: string;
  openingDirection: OpeningDirection;
  openingCurrency: OpeningCurrency;
  openingDate: string;
  openingNote: string;
  creditLimit: string;
  currency: Currency;
  paymentTerms: PaymentTerms;
  paymentMethod: PaymentMethod;
  defaultDiscount: string;
  vat: string;
  notes: string;
};

export const emptyDraft = (kind: PartyKind): Draft => ({
  code: "",
  name: "",
  companyName: "",
  commercialReg: "",
  category: "",
  salesRep: "",
  taxNumber: "",
  status: "active",
  phone: "",
  mobile: "",
  whatsapp: "",
  email: "",
  website: "",
  address: "",
  city: "",
  country: "سوريا",
  openingAmount: "",
  openingDirection: positiveDirection(kind),
  openingCurrency: "SYP",
  openingDate: "",
  openingNote: "",
  creditLimit: "",
  currency: "SYP",
  paymentTerms: "cash",
  paymentMethod: "cash",
  defaultDiscount: "",
  vat: "",
  notes: "",
});

/**
 * One field change. Choosing the party's default currency also moves the opening balance's
 * currency — they were independent, so a USD customer's opening balance was recorded in ل.س unless
 * the user also changed the second selector — until the user picks the opening currency itself.
 */
export function applyDraftChange<K extends keyof Draft>(
  d: Draft,
  key: K,
  value: Draft[K],
  openingCurrencyChosen: boolean,
): Draft {
  const next = { ...d, [key]: value };
  if (key === "currency" && !openingCurrencyChosen && (value === "USD" || value === "SYP")) {
    next.openingCurrency = value as OpeningCurrency;
  }
  return next;
}

export const fromParty = (p: SimpleParty, kind: PartyKind): Draft => ({
  code: p.code ?? "",
  name: p.name ?? "",
  companyName: p.companyName ?? "",
  commercialReg: p.commercialReg ?? "",
  category: p.category ?? "",
  salesRep: p.salesRep ?? "",
  taxNumber: p.taxNumber ?? "",
  status: p.status ?? "active",
  phone: p.phone ?? "",
  mobile: p.mobile ?? "",
  whatsapp: p.whatsapp ?? "",
  email: p.email ?? "",
  website: p.website ?? "",
  address: p.address ?? "",
  city: p.city ?? "",
  country: p.country ?? "سوريا",
  openingAmount: p.openingBalance ? String(Math.abs(p.openingBalance)) : "",
  openingDirection:
    (p.openingBalance ?? 0) < 0
      ? positiveDirection(kind) === "they_owe_us"
        ? "we_owe_them"
        : "they_owe_us"
      : positiveDirection(kind),
  openingCurrency: (p.openingCurrency ?? p.currency) === "USD" ? "USD" : "SYP",
  openingDate: p.openingDate ?? "",
  openingNote: p.openingNote ?? "",
  creditLimit: p.creditLimit != null ? String(p.creditLimit) : "",
  currency: p.currency ?? "SYP",
  paymentTerms: p.paymentTerms ?? "cash",
  paymentMethod: p.paymentMethod ?? "cash",
  defaultDiscount: p.defaultDiscount != null ? String(p.defaultDiscount) : "",
  vat:
    p.vat != null && Number(p.vat) !== 0
      ? String(Number(p.vat) > 1 ? Number(p.vat) : Math.round(Number(p.vat) * 10000) / 100)
      : "",
  notes: p.notes ?? "",
});

export const openingAmountOf = (d: Draft): number =>
  d.openingAmount === "" ? 0 : Number(d.openingAmount);

/**
 * Save-time check of the opening balance. `is2dp` tolerates binary float error: the exact test it
 * replaces (Math.round(a * 100) !== a * 100) rejected ordinary amounts like 32,900.13 or 19.99.
 */
export const openingAmountError = (d: Draft): string | null => {
  const amount = openingAmountOf(d);
  return !Number.isFinite(amount) || amount < 0 || !is2dp(amount)
    ? "مبلغ الرصيد السابق يجب أن يكون رقماً موجباً بخانتين عشريتين على الأكثر."
    : null;
};

/** True when the opening section differs from what the party has now. */
export const openingChanged = (d: Draft, before: Draft): boolean => {
  const a = openingAmountOf(d);
  const b = openingAmountOf(before);
  if (a === 0 && b === 0) return false;
  return (
    a !== b ||
    d.openingDirection !== before.openingDirection ||
    d.openingCurrency !== before.openingCurrency ||
    (d.openingDate || "") !== (before.openingDate || "") ||
    d.openingNote.trim() !== before.openingNote.trim()
  );
};

export const toPatch = (
  d: Draft,
  kind: PartyKind,
  editing: SimpleParty | undefined,
): Omit<SimpleParty, "id"> => {
  const vatPct = d.vat === "" ? 0 : Number(d.vat) || 0;
  // UI is always percent (16); DB stores fraction (0.16) in decimal(5,4).
  const vatFraction = Math.min(1, Math.max(0, vatPct / 100));
  // Edit: a cleared field is sent as "" (the server stores NULL). `|| undefined` dropped it from the
  // JSON, so the old phone/email/address silently stayed while the dialog said "saved".
  const txt = (v: string) => (editing ? v.trim() : v.trim() || undefined);
  const patch: Omit<SimpleParty, "id"> = {
    code: d.code.trim() || undefined,
    name: d.name.trim(),
    companyName: txt(d.companyName),
    commercialReg: txt(d.commercialReg),
    category: kind === "supplier" ? txt(d.category) : undefined,
    salesRep: kind === "customer" ? txt(d.salesRep) : undefined,
    taxNumber: txt(d.taxNumber),
    status: d.status,
    phone: txt(d.phone),
    mobile: txt(d.mobile),
    whatsapp: txt(d.whatsapp),
    email: txt(d.email),
    website: txt(d.website),
    address: txt(d.address),
    city: txt(d.city),
    country: txt(d.country),
    creditLimit: d.creditLimit === "" ? 0 : Number(d.creditLimit) || 0,
    currency: d.currency,
    paymentTerms: d.paymentTerms,
    paymentMethod: d.paymentMethod,
    defaultDiscount: d.defaultDiscount === "" ? 0 : Number(d.defaultDiscount) || 0,
    vat: vatFraction,
    notes: txt(d.notes),
  };
  // Optimistic concurrency: the version this form was OPENED with. Without it the API client re-read
  // the current version before saving, so an edit made meanwhile on another device was overwritten.
  if (editing && typeof editing.version === "number") patch.version = editing.version;
  // Create: the opening journal is written with the party. Edit: a plain field
  // update refuses opening fields, so a changed balance travels as `opening`
  // (PUT …/:id/opening — old journal cancelled, new one posted).
  const amount = openingAmountOf(d);
  if (!editing) {
    patch.openingBalance = d.openingDirection === positiveDirection(kind) ? amount : -amount;
    if (amount !== 0) {
      patch.openingCurrency = d.openingCurrency;
      patch.openingDate = d.openingDate || undefined;
      patch.openingNote = d.openingNote.trim() || undefined;
    }
  } else if (openingChanged(d, fromParty(editing, kind))) {
    patch.opening = {
      amount,
      direction: d.openingDirection,
      currency: d.openingCurrency,
      date: d.openingDate || localToday(),
      note: d.openingNote.trim() || null,
    };
  }
  return patch;
};
