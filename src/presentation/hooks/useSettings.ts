import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { container } from "@/infrastructure/container";
import type { SettingsSection } from "@/infrastructure/api";
import { setExchangeRate, type Currency } from "@/presentation/hooks/useCurrency";
import { FIXED_COMPANY_CONTACT, formatCompanyPhoneField } from "@/shared/constants/printConfig";

import { localToday } from "@/lib/localDate";
export type ActivityEntry = {
  id: string;
  at: string;
  userId?: string;
  user?: string;
  userName?: string;
  module: string;
  action: string;
  detail?: string;
};

/**
 * Clean settings hook — self-contained state with no dependency on legacy
 * mock files. Seeded with default values matching the project's initial
 * configuration.
 */

/* ── Types ──────────────────────────────────────────────────────────── */

export type Unit = { id: string; name: string; symbol: string; isDefault: boolean };
export type Tax = { id: string; name: string; rate: number; enabled: boolean };
export type Warehouse = { id: string; name: string; location: string; isDefault: boolean };
export type PaymentMethod = { id: string; name: string; enabled: boolean };
export type PrintingSettings = {
  paperSize: "A4" | "A5" | "80mm";
  showLogo: boolean;
  footerNote: string;
  copies: number;
  /** hermes F-017: per-invoice-kind print field visibility (was localStorage-only). */
  invoiceVisibility?: Record<string, Record<string, boolean>>;
};
export type CompanySettings = {
  name: string;
  nameEn: string;
  commercialReg: string;
  taxNumber: string;
  phone: string;
  email: string;
  address: string;
  city: string;
};

export type UserRole = "admin" | "accountant" | "warehouse" | "viewer";
export const ROLE_LABEL: Record<UserRole, string> = {
  admin: "مدير النظام",
  accountant: "محاسب",
  warehouse: "مسؤول مستودع",
  viewer: "مشاهد",
};

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: ["كل الصلاحيات"],
  accountant: ["كل الصلاحيات عدا منح دور مدير النظام"],
  warehouse: ["المخزون", "فاتورة دخول", "مرتجع دخول"],
  viewer: ["عرض فقط"],
};

export const ROLE_ALLOWED_PATHS: Record<UserRole, string[]> = {
  admin: ["*"],
  accountant: ["*"],
  warehouse: [
    "/",
    "/inventory",
    "/invoices/entry",
    "/returns/entry",
    "/print-center",
    "/sync/conflicts",
  ],
  viewer: ["/", "/inventory", "/customers", "/suppliers", "/reports", "/reports/"],
};

// Owner decision (2026-10-12): the accountant holds every admin privilege except granting or
// removing the admin role (enforced on the server in user.route.ts / invitation.route.ts).
export function hasAdminPrivileges(role: string | undefined | null): boolean {
  return role === "admin" || role === "accountant";
}

export function roleCanAccess(role: UserRole, path: string): boolean {
  const list = ROLE_ALLOWED_PATHS[role];
  if (list.includes("*")) return true;
  return list.some(
    (p) => path === p || path.startsWith(p + "/") || (p !== "/" && path.startsWith(p)),
  );
}

/* ── Store (self-contained, no mock dependency) ─────────────────────── */

const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version++;
  listeners.forEach((l) => l());
}

function useVersion() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => version,
    () => 0,
  );
}

let seq = 2000;
function nextId(prefix = "id"): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/* ── Settings state ────────────────────────────────────────────────── */

export const settings = {
  company: {
    name: "Motard Fabrics Group",
    nameEn: "",
    commercialReg: "",
    taxNumber: "",
    // Issue 14: single source — defaults match protocol contact; also stored via PUT /settings/company
    phone: formatCompanyPhoneField(),
    email: "",
    address: FIXED_COMPANY_CONTACT.address,
    city: "حلب",
  } as CompanySettings,
  taxes: [{ id: "t1", name: "ضريبة القيمة المضافة", rate: 0, enabled: true }] as Tax[],
  warehouses: [
    { id: "w1", name: "المستودع الرئيسي", location: "دمشق", isDefault: true },
  ] as Warehouse[],
  paymentMethods: [
    { id: "pm1", name: "نقدي", enabled: true },
    { id: "pm2", name: "تحويل بنكي", enabled: true },
    { id: "pm3", name: "شيك", enabled: true },
  ] as PaymentMethod[],
  units: [
    { id: "u1", name: "كيلوغرام", symbol: "كغ", isDefault: true },
    { id: "u2", name: "متر", symbol: "م", isDefault: false },
    { id: "u3", name: "قطعة", symbol: "قطعة", isDefault: false },
  ] as Unit[],
  currencies: [
    { code: "SYP", rate: 1 },
    { code: "USD", rate: 13500 },
    { code: "EUR", rate: 14700 },
  ] as { code: string; rate: number }[],
  printing: {
    paperSize: "A4" as const,
    showLogo: true,
    footerNote: "شكراً لتعاملكم معنا",
    copies: 1,
  } as PrintingSettings,
  activity: [] as ActivityEntry[],
};

/* ── Generic helpers ───────────────────────────────────────────────── */

function makeDefault<T extends { id: string; isDefault: boolean }>(list: T[], id: string) {
  list.forEach((x) => (x.isDefault = x.id === id));
}

export function logActivity(module: string, action: string, detail?: string) {
  settings.activity.unshift({
    id: nextId("act"),
    at: new Date().toISOString().replace("T", " ").slice(0, 19),
    user: "هذا الجهاز",
    module,
    action,
    detail,
  });
  if (settings.activity.length > 500) settings.activity.length = 500;
}

/** Issue 14 — ensure company address/phone in settings match protocol contact when empty. */
function ensureCompanyContactDefaults(): boolean {
  let patched = false;
  if (!(settings.company.address ?? "").trim()) {
    settings.company.address = FIXED_COMPANY_CONTACT.address;
    patched = true;
  }
  if (!(settings.company.phone ?? "").trim()) {
    settings.company.phone = formatCompanyPhoneField();
    patched = true;
  }
  return patched;
}

let loadStarted = false;
/** True once the server's settings have been merged (F-018: a form must not save before this). */
let loaded = false;
const dirty = new Set<string>();

function persistSection(section: SettingsSection) {
  dirty.add(section);
  const value = (settings as Record<string, unknown>)[section];
  container.settings.api
    .updateSection(section, value)
    .then(() => {
      dirty.delete(section);
      toast.success("تم حفظ الإعدادات");
    })
    .catch((e) =>
      toast.error(`فشل حفظ الإعدادات: ${e instanceof Error ? e.message : "خطأ غير معروف"}`),
    );
}

export async function loadSettings(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const data = await container.settings.api.getSettings();
    loaded = true;
    if (!data || typeof data !== "object") {
      notify();
      return;
    }
    const merged: Record<string, unknown> = {};
    if (data.company && typeof data.company === "object" && Object.keys(data.company).length) {
      merged.company = data.company;
    }
    if (Array.isArray(data.units)) merged.units = data.units;
    if (Array.isArray(data.taxes)) merged.taxes = data.taxes;
    if (Array.isArray(data.warehouses)) merged.warehouses = data.warehouses;
    // An empty server list (fresh tenant row defaults to []) must not wipe the
    // built-in methods — the invoice "الدفع" dropdown would render blank.
    if (Array.isArray(data.paymentMethods) && data.paymentMethods.length)
      merged.paymentMethods = data.paymentMethods;
    if (Array.isArray(data.currencies) && data.currencies.length)
      merged.currencies = data.currencies;
    if (data.printing && typeof data.printing === "object" && Object.keys(data.printing).length) {
      merged.printing = data.printing;
    }
    let changed = true; // `loaded` flipped — subscribers re-render even when nothing was merged
    for (const key of Object.keys(merged)) {
      if (dirty.has(key)) continue;
      (settings as Record<string, unknown>)[key] = merged[key];
      changed = true;
    }
    if (changed) notify();
    // Issue 14: seed empty address/phone once into DB from protocol contact
    if (ensureCompanyContactDefaults()) {
      notify();
      persistSection("company");
    }
    // Apply persisted exchange rates to the live currency state (fallback to defaults).
    const currencies = (settings as Record<string, unknown>).currencies as
      { code: string; rate: number }[] | undefined;
    if (Array.isArray(currencies)) {
      for (const c of currencies) {
        if (c && typeof c.code === "string" && typeof c.rate === "number" && c.rate > 0) {
          setExchangeRate(c.code as Currency, c.rate);
        }
      }
    }
  } catch (e) {
    // A later mount retries; until then forms built on useSettingsDraft cannot save defaults over data.
    loadStarted = false;
    console.warn("[useSettings] فشل جلب الإعدادات من الخادم، تم استخدام القيم الافتراضية", e);
  }
}

/* ── Units CRUD ────────────────────────────────────────────────────── */

export function addUnit(v: Omit<Unit, "id">): Unit {
  const u: Unit = { ...v, id: nextId("u") };
  if (u.isDefault) makeDefault(settings.units, u.id);
  settings.units.push(u);
  logActivity("الإعدادات", "إضافة وحدة قياس", u.name);
  notify();
  persistSection("units");
  return u;
}

export function updateUnit(id: string, patch: Partial<Unit>) {
  const u = settings.units.find((x) => x.id === id);
  if (!u) return;
  Object.assign(u, patch);
  if (patch.isDefault) makeDefault(settings.units, id);
  logActivity("الإعدادات", "تعديل وحدة قياس", u.name);
  notify();
  persistSection("units");
}

export function deleteUnit(id: string) {
  const u = settings.units.find((x) => x.id === id);
  settings.units = settings.units.filter((x) => x.id !== id);
  if (u) logActivity("الإعدادات", "حذف وحدة قياس", u.name);
  notify();
  persistSection("units");
}

/* ── Warehouses CRUD ───────────────────────────────────────────────── */

export function addWarehouse(v: Omit<Warehouse, "id">): Warehouse {
  const w: Warehouse = { ...v, id: nextId("w") };
  if (w.isDefault) makeDefault(settings.warehouses, w.id);
  settings.warehouses.push(w);
  logActivity("الإعدادات", "إضافة مستودع", w.name);
  notify();
  persistSection("warehouses");
  return w;
}

export function updateWarehouse(id: string, patch: Partial<Warehouse>) {
  const w = settings.warehouses.find((x) => x.id === id);
  if (!w) return;
  Object.assign(w, patch);
  if (patch.isDefault) makeDefault(settings.warehouses, id);
  logActivity("الإعدادات", "تعديل مستودع", w.name);
  notify();
  persistSection("warehouses");
}

export function deleteWarehouse(id: string) {
  const w = settings.warehouses.find((x) => x.id === id);
  settings.warehouses = settings.warehouses.filter((x) => x.id !== id);
  if (w) logActivity("الإعدادات", "حذف مستودع", w.name);
  notify();
  persistSection("warehouses");
}

/* ── Taxes CRUD ────────────────────────────────────────────────────── */

export function addTax(v: Omit<Tax, "id">): Tax {
  const t: Tax = { ...v, id: nextId("t") };
  settings.taxes.push(t);
  logActivity("الإعدادات", "إضافة ضريبة", t.name);
  notify();
  persistSection("taxes");
  return t;
}

export function updateTax(id: string, patch: Partial<Tax>) {
  const t = settings.taxes.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  logActivity("الإعدادات", "تعديل ضريبة", t.name);
  notify();
  persistSection("taxes");
}

export function deleteTax(id: string) {
  const t = settings.taxes.find((x) => x.id === id);
  settings.taxes = settings.taxes.filter((x) => x.id !== id);
  if (t) logActivity("الإعدادات", "حذف ضريبة", t.name);
  notify();
  persistSection("taxes");
}

/* ── Payment methods CRUD ──────────────────────────────────────────── */

export function addPaymentMethod(v: Omit<PaymentMethod, "id">): PaymentMethod {
  const p: PaymentMethod = { ...v, id: nextId("pm") };
  settings.paymentMethods.push(p);
  logActivity("الإعدادات", "إضافة طريقة دفع", p.name);
  notify();
  persistSection("paymentMethods");
  return p;
}

export function updatePaymentMethod(id: string, patch: Partial<PaymentMethod>) {
  const p = settings.paymentMethods.find((x) => x.id === id);
  if (!p) return;
  Object.assign(p, patch);
  logActivity("الإعدادات", "تعديل طريقة دفع", p.name);
  notify();
  persistSection("paymentMethods");
}

export function deletePaymentMethod(id: string) {
  const p = settings.paymentMethods.find((x) => x.id === id);
  settings.paymentMethods = settings.paymentMethods.filter((x) => x.id !== id);
  if (p) logActivity("الإعدادات", "حذف طريقة دفع", p.name);
  notify();
  persistSection("paymentMethods");
}

/* ── Users ───────────────────────────────────────────────────────── */
// hermes F-015: users are NOT a settings section. /settings/users reads and edits the real `users`
// table through container.users.api; accounts are created by accepting an invitation.

/* ── Company & printing ────────────────────────────────────────────── */

export function updateCompany(v: CompanySettings) {
  settings.company = { ...v };
  logActivity("الإعدادات", "تحديث بيانات الشركة", v.name);
  notify();
  persistSection("company");
}

export function updatePrinting(v: PrintingSettings) {
  // Only the form's own fields: a printing form's copy must not overwrite invoiceVisibility saved
  // meanwhile from the same screen (F-017 / C1-20).
  const { paperSize, showLogo, footerNote, copies } = v;
  settings.printing = { ...settings.printing, paperSize, showLogo, footerNote, copies };
  logActivity("الإعدادات", "تحديث إعدادات الطباعة");
  notify();
  persistSection("printing");
}

/** hermes F-017: print visibility is part of the replicated `printing` section. */
export function updatePrintVisibility(v: Record<string, Record<string, boolean>>) {
  settings.printing = { ...settings.printing, invoiceVisibility: v };
  notify();
  persistSection("printing");
}

export function updateCurrencyRate(code: string, rate: number) {
  const cur = settings.currencies;
  const existing = cur.find((c) => c.code === code);
  if (existing) existing.rate = rate;
  else cur.push({ code, rate });
  setExchangeRate(code as Currency, rate);
  logActivity("الإعدادات", "تعديل سعر صرف", `${code}: ${rate}`);
  notify();
  persistSection("currencies");
}

/* ── Settings file export / import (/settings/backup) ─────────────── */

/** The sections the server stores (PUT /api/settings/:section) — all a settings file carries. */
export const PERSISTED_SETTING_SECTIONS = [
  "company",
  "currencies",
  "paymentMethods",
  "taxes",
  "units",
  "warehouses",
  "printing",
] as const satisfies readonly SettingsSection[];

/** C1-17: only the persisted sections — no user records, no device-local activity. */
export function exportableSettings(): Record<string, unknown> {
  return Object.fromEntries(
    PERSISTED_SETTING_SECTIONS.map((k) => [k, (settings as Record<string, unknown>)[k]]),
  );
}

/**
 * C1-16: an imported settings file used to change memory only — the page said "restored" while
 * nothing reached the server and a reload brought the old values back. Each imported section is now
 * saved like an edit on its own screen. Returns the sections applied.
 */
export function applyImportedSettings(src: Record<string, unknown>): string[] {
  const applied: string[] = [];
  for (const key of PERSISTED_SETTING_SECTIONS) {
    const v = src[key];
    const ok =
      key === "company" || key === "printing"
        ? v && typeof v === "object" && !Array.isArray(v)
        : Array.isArray(v);
    if (!ok) continue;
    (settings as Record<string, unknown>)[key] = v;
    applied.push(key);
  }
  for (const c of settings.currencies) {
    if (c && typeof c.code === "string" && typeof c.rate === "number" && c.rate > 0) {
      setExchangeRate(c.code as Currency, c.rate);
    }
  }
  if (applied.length) {
    logActivity("النسخ الاحتياطي", "استعادة إعدادات", applied.join("، "));
    notify();
    for (const key of applied) persistSection(key as SettingsSection);
  }
  return applied;
}

/* ── Activity log ──────────────────────────────────────────────────── */

export function clearActivity() {
  settings.activity = [];
  notify();
}

/* ── Hook ──────────────────────────────────────────────────────────── */

export function useSettings() {
  useVersion();
  useEffect(() => {
    void loadSettings();
  }, []);
  return settings;
}

/** Whether the server's settings have been merged yet. */
export function settingsLoaded(): boolean {
  return loaded;
}

/**
 * hermes F-018: an editable copy of one settings object. Forms used to copy the BUILT-IN defaults
 * into their state before the server GET resolved, so an early «حفظ» PUT the defaults over the saved
 * company/printing data. The copy is re-seeded when the server data arrives, and `ready` stays false
 * (save disabled) until then.
 */
export function useSettingsDraft<K extends "company" | "printing">(key: K) {
  useSettings(); // re-renders when the load completes
  const ready = settingsLoaded();
  const [draft, setDraft] = useState<(typeof settings)[K]>(() => ({ ...settings[key] }));
  useEffect(() => {
    if (ready) setDraft({ ...settings[key] });
  }, [key, ready]);
  return [draft, setDraft, ready] as const;
}
