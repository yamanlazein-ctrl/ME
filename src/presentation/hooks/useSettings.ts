import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { container } from "@/infrastructure/container";
import type { SettingsSection } from "@/infrastructure/api";
import { setExchangeRate, type Currency } from "@/presentation/hooks/useCurrency";

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
export type SystemUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  password?: string;
  licenseKey: string;
};

export const ROLE_LABEL: Record<UserRole, string> = {
  admin: "مدير الظام",
  accountant: "محاسب",
  warehouse: "مسؤول مستودع",
  viewer: "مشاهد",
};

export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  admin: ["كل الصلاحيات"],
  accountant: ["الفواتير", "المرتجعات", "الصندوق", "التقارير"],
  warehouse: ["المخزون", "فاتورة دخول", "مرتجع دخول"],
  viewer: ["عرض فقط"],
};

export const ROLE_ALLOWED_PATHS: Record<UserRole, string[]> = {
  admin: ["*"],
  accountant: [
    "/",
    "/invoices",
    "/returns",
    "/orders",
    "/receipts",
    "/payments",
    "/expenses",
    "/ledger",
    "/cashbox",
    "/reports",
    "/print-center",
    "/customers",
    "/suppliers",
  ],
  warehouse: ["/", "/inventory", "/invoices/entry", "/returns/entry", "/print-center"],
  viewer: ["/", "/inventory", "/customers", "/suppliers", "/reports"],
};

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

function randSeg(len: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function generateLicenseKey(role: UserRole): string {
  const roleTag = role.slice(0, 3).toUpperCase();
  return `MF-${roleTag}-${randSeg(4)}-${randSeg(4)}-${randSeg(4)}`;
}

/* ── Settings state ────────────────────────────────────────────────── */

export const settings = {
  company: {
    name: "مطارد للأقمشة",
    nameEn: "Motared Fabrics Group",
    commercialReg: "",
    taxNumber: "",
    phone: "",
    email: "",
    address: "",
    city: "",
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
  users: [
    {
      id: "usr-1",
      name: "مدير النظام",
      email: "admin",
      role: "admin" as UserRole,
      active: true,
      createdAt: new Date().toISOString().slice(0, 10),
      password:
        typeof process !== "undefined"
          ? process.env.VITE_MOCK_ADMIN_PASSWORD || "NOT_SET"
          : "NOT_SET",
      licenseKey: "MF-ADM-0000-0000-0001",
    },
  ] as SystemUser[],
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
    user: settings.users[0]?.name ?? "النظام",
    module,
    action,
    detail,
  });
  if (settings.activity.length > 500) settings.activity.length = 500;
}

/* ── API sync (GET /settings + PUT /settings/:section) ───────────── */

let loadStarted = false;
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
    if (!data || typeof data !== "object") return;
    const merged: Record<string, unknown> = {};
    if (data.company && typeof data.company === "object" && Object.keys(data.company).length) {
      merged.company = data.company;
    }
    if (Array.isArray(data.units)) merged.units = data.units;
    if (Array.isArray(data.taxes)) merged.taxes = data.taxes;
    if (Array.isArray(data.warehouses)) merged.warehouses = data.warehouses;
    if (Array.isArray(data.paymentMethods)) merged.paymentMethods = data.paymentMethods;
    if (Array.isArray(data.currencies) && data.currencies.length) merged.currencies = data.currencies;
    if (data.printing && typeof data.printing === "object" && Object.keys(data.printing).length) {
      merged.printing = data.printing;
    }
    let changed = false;
    for (const key of Object.keys(merged)) {
      if (dirty.has(key)) continue;
      (settings as Record<string, unknown>)[key] = merged[key];
      changed = true;
    }
    if (changed) notify();
    // Apply persisted exchange rates to the live currency state (fallback to defaults).
    const currencies = (settings as Record<string, unknown>).currencies as
      | { code: string; rate: number }[]
      | undefined;
    if (Array.isArray(currencies)) {
      for (const c of currencies) {
        if (c && typeof c.code === "string" && typeof c.rate === "number" && c.rate > 0) {
          setExchangeRate(c.code as Currency, c.rate);
        }
      }
    }
  } catch (e) {
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

/* ── Users CRUD ────────────────────────────────────────────────────── */

export function addUser(
  v: Omit<SystemUser, "id" | "createdAt" | "licenseKey"> & { licenseKey?: string },
): SystemUser {
  const u: SystemUser = {
    ...v,
    id: nextId("usr"),
    createdAt: new Date().toISOString().slice(0, 10),
    licenseKey: v.licenseKey || generateLicenseKey(v.role),
  };
  settings.users.push(u);
  logActivity("المستخدمون", "إضافة مستخدم", `${u.name} — ${ROLE_LABEL[u.role]}`);
  notify();
  return u;
}

export function regenerateLicenseKey(id: string): string | undefined {
  const u = settings.users.find((x) => x.id === id);
  if (!u) return undefined;
  u.licenseKey = generateLicenseKey(u.role);
  logActivity("المستخدمون", "توليد مفتاح جديد", u.name);
  notify();
  return u.licenseKey;
}

export function updateUser(id: string, patch: Partial<SystemUser>) {
  const u = settings.users.find((x) => x.id === id);
  if (!u) return;
  Object.assign(u, patch);
  logActivity("المستخدمون", "تعديل مستخدم", u.name);
  notify();
}

export function deleteUser(id: string) {
  const u = settings.users.find((x) => x.id === id);
  settings.users = settings.users.filter((x) => x.id !== id);
  if (u) logActivity("المستخدمون", "حذف مستخدم", u.name);
  notify();
}

/* ── Company & printing ────────────────────────────────────────────── */

export function updateCompany(v: CompanySettings) {
  settings.company = { ...v };
  logActivity("الإعدادات", "تحديث بيانات الشركة", v.name);
  notify();
  persistSection("company");
}

export function updatePrinting(v: PrintingSettings) {
  settings.printing = { ...v };
  logActivity("الإعدادات", "تحديث إعدادات الطباعة");
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
