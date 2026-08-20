import { Fragment, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Paperclip,
  Pencil,
  Plus,
  Printer,
  Trash2,
  Truck,
  User,
  Wallet,
  FileText,
  ClipboardList,
  BarChart3,
  StickyNote,
  History,
  AlertTriangle,
  ChevronDown,
  Download,
  Scale,
  X,
} from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { printDocument } from "@/components/print/printPortal";
import { PartyStatementDocument } from "@/components/print/PartyStatementDocument";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PartyFormDialog, type PartyKind } from "./PartyFormDialog";
import {
  addPartyAttachment,
  customerById,
  deleteCustomer,
  deleteSupplier,
  removePartyAttachment,
  supplierById,
  updateCustomer,
  updateSupplier,
  useParties,
} from "@/presentation/hooks/useParties";
import { useInventory, colors, fabrics } from "@/presentation/hooks/useInventory";
import {
  currencySymbol,
  formatCurrencyBreakdown,
  type Currency,
} from "@/presentation/hooks/useCurrency";
import type { Party } from "@/domain/entities/Party";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useCreateReceiptVoucher } from "@/presentation/hooks/useVouchers";
import { invoiceTotal, invoiceRemaining } from "@/core/calculations/invoiceCalc";
import {
  buildFabricHistory,
  buildOutstanding,
  buildPartyStats,
  buildPartyStatsByCurrency,
  LEDGER_TYPE_LABEL,
  useLedgerEntries,
  type LedgerType,
} from "@/presentation/hooks/useLedger";
import { useStatement, useSettleParty } from "@/presentation/hooks/useStatement";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";

const _nextFormId = 0;
function toMockPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) out[k] = void 0 as unknown;
    else out[k] = v;
  }
  return out;
}

const TAB_DEFS = [
  { id: "overview", label: "نظرة عامة", icon: ClipboardList },
  { id: "invoices", label: "الفواتير", icon: FileText },
  { id: "payments", label: "الدفعات", icon: Wallet },
  { id: "statement", label: "كشف حساب", icon: FileText },
  { id: "outstanding", label: "الرصيد المستحق", icon: AlertTriangle },
  { id: "stats", label: "إحصائيات", icon: BarChart3 },
  { id: "attachments", label: "المرفقات", icon: Paperclip },
  { id: "notes", label: "ملاحظات", icon: StickyNote },
  { id: "activity", label: "سجل النشاط", icon: History },
] as const;
type TabId = (typeof TAB_DEFS)[number]["id"];

const TERMS_LABEL: Record<string, string> = {
  cash: "نقدي",
  net15: "15 يوم",
  net30: "30 يوم",
  net60: "60 يوم",
  net90: "90 يوم",
};
const METHOD_LABEL: Record<string, string> = {
  cash: "نقدي",
  transfer: "حوالة بنكية",
  check: "شيك",
  card: "بطاقة",
};

const fmt = (n: number) => formatMoney(n);

/**
 * Extract the trailing integer from a human invoice number (e.g. "INV-2864" → 2864).
 * Used only as a deterministic tie-breaker when two invoices share the same date.
 */
function invoiceSeqNumber(n: string): number {
  const m = String(n).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : NaN;
}

/**
 * Sum per-currency settled amounts (تسوية حساب) for a party from ledger entries.
 * A settlement posts a single-side movement that zeroes the party balance, so its
 * magnitude (max of debit/credit) reduces the party's outstanding — for both
 * customers (credit side) and suppliers (debit side). The contra entry carries
 * partyId = null and is ignored. Cancelled settlements are excluded.
 */
function settledByParty(
  entries: ReadonlyArray<{
    partyId?: string | null;
    type?: string;
    referenceType?: string;
    status?: string;
    debit?: number;
    credit?: number;
    currency?: string;
  }>,
  partyId: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    if (!e || e.partyId !== partyId) continue;
    if ((e.status ?? "active") !== "active") continue;
    const isSettlement = e.type === "settlement" || e.referenceType === "settlement";
    if (!isSettlement) continue;
    const amt = Math.max(e.debit ?? 0, e.credit ?? 0);
    if (amt <= 0) continue;
    const c = e.currency ?? "SYP";
    out[c] = (out[c] ?? 0) + amt;
  }
  return out;
}

export function PartyDetailsPage({ kind, id }: { kind: PartyKind; id: string }) {
  useInventory();
  useParties();
  const { data: invoicesData } = useInvoicesList();
  const allInvoices = invoicesData?.data ?? [];
  const { data: vouchersData } = useVouchersList();
  const allVouchers = vouchersData?.data ?? [];
  const { data: ledgerEntries = [] } = useLedgerEntries({ limit: 1000 });
  const navigate = useNavigate();
  const isSup = kind === "supplier";
  const p: Party | undefined = isSup ? supplierById(id) : customerById(id);

  const [tab, setTab] = useState<TabId>("overview");
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  if (!p) {
    return (
      <AppShell
        title="سجل غير موجود"
        subtitle={isSup ? "المورد المطلوب غير متوفر." : "العميل المطلوب غير متوفر."}
      >
        <PageCard title="غير موجود" description="ربما تم حذف هذا السجل.">
          <Link
            to={isSup ? "/suppliers" : "/customers"}
            className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline"
          >
            <ArrowRight className="h-4 w-4" /> العودة إلى القائمة
          </Link>
        </PageCard>
      </AppShell>
    );
  }

  const statsByCurrency = buildPartyStatsByCurrency(p, kind, allInvoices, allVouchers);
  // Settlement-awareness (fix D/E): a party settlement (تسوية) is written as a
  // ledger entry, not a voucher, so the invoice/voucher-based stats would keep
  // showing stale outstanding. Reduce each currency's remaining by its settled
  // amount — single-currency, never across currencies.
  const settled = settledByParty(ledgerEntries, p.id);
  const settlementStats: Record<string, (typeof statsByCurrency)[string]> = {};
  for (const [ccy, stats] of Object.entries(statsByCurrency)) {
    const amt = settled[ccy] ?? 0;
    if (amt > 0) settlementStats[ccy] = { ...stats, remaining: Math.max(0, stats.remaining - amt) };
    else settlementStats[ccy] = stats;
  }
  const active = (p.status ?? "active") === "active";

  return (
    <AppShell
      title={p.name}
      subtitle={
        isSup
          ? `${p.code ?? ""} — حساب المورد الكامل مع كشف الحساب وسجل المشتريات.`
          : `${p.code ?? ""} — حساب العميل الكامل مع كشف الحساب وسجل المبيعات.`
      }
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setEditing(true)} className="h-10 gap-2">
            <Pencil className="h-4 w-4" /> تعديل
          </Button>
          <Button
            variant="outline"
            onClick={() => setConfirmDel(true)}
            className="h-10 gap-2 border-destructive/40 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" /> حذف
          </Button>
          <Link
            to={isSup ? "/suppliers" : "/customers"}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-secondary"
          >
            <ArrowRight className="h-4 w-4" /> القائمة
          </Link>
        </div>
      }
    >
      {/* Identity header */}
      <PageCard
        title="بطاقة الحساب"
        description={isSup ? "الملف الرئيسي للمورد." : "الملف الرئيسي للعميل."}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-xl bg-primary/15 text-primary">
            {isSup ? <Truck className="h-6 w-6" /> : <User className="h-6 w-6" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-foreground">{p.name}</span>
              <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                {p.code ?? "—"}
              </span>
            </div>
            {p.companyName && <div className="text-xs text-muted-foreground">{p.companyName}</div>}
          </div>
          <span
            className={`inline-flex items-center rounded-md px-3 py-1 text-xs font-semibold ${
              active ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
            }`}
          >
            {active ? "نشط" : "موقوف"}
          </span>
        </div>
      </PageCard>

      {/* KPI strip — per-currency breakdown, never mixes currencies */}
      <PageCard
        title={isSup ? "ملخص المشتريات" : "ملخص المبيعات"}
        description="لمحة سريعة عن الحساب — منفصلة لكل عملة."
        tone="primary"
      >
        {Object.entries(settlementStats).length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            لا حركات مسجلة لهذا الحساب.
          </div>
        ) : (
          <div className="space-y-3">
            {Object.entries(settlementStats).map(([ccy, stats]) => {
              const cur = currencySymbol(ccy as Currency);
              return (
                <div
                  key={ccy}
                  className="rounded-lg border border-border/60 bg-background/60 px-3 py-2"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                      {cur}
                    </span>
                    <span className="text-[11px] font-semibold text-muted-foreground">
                      {stats.invoicesCount} فاتورة · {fmt(stats.totalKg)} كغ
                    </span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
                    <Kpi label="الإجمالي" value={fmt(stats.totalAmount)} suffix={cur} />
                    <Kpi label="المدفوع" value={fmt(stats.totalPaid)} suffix={cur} />
                    <Kpi
                      label="المتبقي"
                      value={fmt(stats.remaining)}
                      suffix={cur}
                      tone={stats.remaining > 0 ? "warn" : "good"}
                    />
                    <Kpi label="متوسط الفاتورة" value={fmt(stats.avgInvoice)} suffix={cur} />
                    <Kpi label="آخر عملية" value={stats.lastDate ?? "—"} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </PageCard>

      {/* Tabs */}
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-1 rounded-xl border border-border bg-card/95 p-1 shadow-soft backdrop-blur">
        {TAB_DEFS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-xs font-semibold transition ${
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && <OverviewTab p={p} kind={kind} />}
      {tab === "invoices" && <InvoicesTab p={p} kind={kind} />}
      {tab === "payments" && <PaymentsTab p={p} />}
      {tab === "statement" && <StatementTab p={p} kind={kind} />}
      {tab === "outstanding" && <OutstandingTab p={p} />}
      {tab === "stats" && <StatsTab p={p} kind={kind} />}
      {tab === "attachments" && <AttachmentsTab p={p} />}
      {tab === "notes" && <NotesTab p={p} kind={kind} />}
      {tab === "activity" && <ActivityTab p={p} kind={kind} />}

      <PartyFormDialog
        kind={kind}
        open={editing}
        editing={p}
        onClose={() => setEditing(false)}
        onSubmit={(patch) => {
          const mp = toMockPatch(patch as Record<string, unknown>);
          if (isSup) updateSupplier(p.id, mp as Parameters<typeof updateSupplier>[1]);
          else updateCustomer(p.id, mp as Parameters<typeof updateCustomer>[1]);
          setEditing(false);
        }}
      />

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف السجل</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم حذف "{p.name}". لن يتم حذف الفواتير المرتبطة.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogAction
              onClick={() => {
                if (isSup) deleteSupplier(p.id);
                else deleteCustomer(p.id);
                navigate({ to: isSup ? "/suppliers" : "/customers" });
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              حذف نهائي
            </AlertDialogAction>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

/* ---------------- Overview ---------------- */

function OverviewTab({ p, kind }: { p: Party; kind: PartyKind }) {
  const isSup = kind === "supplier";
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PageCard title="المعلومات الأساسية" description="بيانات التعريف والسجل التجاري.">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Info label="الكود" value={p.code} />
          <Info label="الحالة" value={(p.status ?? "active") === "active" ? "نشط" : "موقوف"} />
          <Info label="اسم الشركة" value={p.companyName} />
          <Info label="السجل التجاري" value={p.commercialReg} />
          <Info label="الرقم الضريبي" value={p.taxNumber} />
          {isSup ? (
            <Info label="تصنيف المورد" value={p.category} />
          ) : (
            <Info label="مندوب المبيعات" value={p.salesRep} />
          )}
        </dl>
      </PageCard>

      <PageCard title="وسائل الاتصال" description="أرقام الهواتف والقنوات الرقمية.">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Info label="الهاتف" value={p.phone} />
          <Info label="الجوال" value={p.mobile} />
          <Info label="واتساب" value={p.whatsapp} />
          <Info label="البريد" value={p.email} />
          <Info label="الموقع" value={p.website} className="col-span-2" />
        </dl>
      </PageCard>

      <PageCard title="العنوان" description="مكان النشاط أو المراسلة.">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Info label="الدولة" value={p.country} />
          <Info label="المدينة" value={p.city} />
          <Info label="العنوان" value={p.address} className="col-span-2" />
        </dl>
      </PageCard>

      <PageCard title="الإعدادات المالية" description="العملة، الائتمان، وشروط الدفع.">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Info
            label="الرصيد الافتتاحي"
            value={`${fmt(p.openingBalance ?? 0)} ${currencySymbol(p.currency ?? "SYP")}`}
          />
          <Info
            label="حد الائتمان"
            value={`${fmt(p.creditLimit ?? 0)} ${currencySymbol(p.currency ?? "SYP")}`}
          />
          <Info label="العملة الافتراضية" value={currencySymbol(p.currency ?? "SYP")} />
          <Info label="شروط الدفع" value={TERMS_LABEL[p.paymentTerms ?? "cash"]} />
          <Info label="طريقة الدفع" value={METHOD_LABEL[p.paymentMethod ?? "cash"]} />
          <Info label="خصم افتراضي" value={p.defaultDiscount ? `${p.defaultDiscount}%` : "—"} />
          <Info label="ضريبة القيمة المضافة" value={p.vat ? `${p.vat}%` : "—"} />
        </dl>
      </PageCard>

      {p.notes && (
        <PageCard title="ملاحظات" description="ملاحظات داخلية.">
          <p className="whitespace-pre-wrap text-sm text-foreground">{p.notes}</p>
        </PageCard>
      )}
    </div>
  );
}

/* ---------------- Invoices ---------------- */

function InvoicesTab({ p, kind }: { p: Party; kind: PartyKind }) {
  const navigate = useNavigate();
  const isSup = kind === "supplier";
  const { data: invData } = useInvoicesList();
  const { data: vData } = useVouchersList();
  const invs = (invData?.data ?? [])
    .filter((i) => i.partyId === p.id && i.status !== "cancelled")
    .sort((a, b) => {
      // Newest date first (requirement A); same-day entries tie-broken by
      // sequence number descending so creation order is preserved.
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const sa = invoiceSeqNumber(a.number);
      const sb = invoiceSeqNumber(b.number);
      if (!Number.isNaN(sa) && !Number.isNaN(sb) && sa !== sb) return sa > sb ? -1 : 1;
      return b.number.localeCompare(a.number);
    });
  // Compute actual paid per invoice from linked vouchers (BUG-8 fix).
  const paidByInvoice = new Map<string, number>();
  for (const v of vData?.data ?? []) {
    if (v.status !== "active" || !v.invoiceId || v.partyId !== p.id) continue;
    paidByInvoice.set(v.invoiceId, (paidByInvoice.get(v.invoiceId) ?? 0) + v.amount);
  }

  return (
    <PageCard
      title={isSup ? "فواتير الشراء" : "فواتير البيع"}
      description="جميع الفواتير المرتبطة بهذا الحساب."
      noBodyPadding
    >
      <div className="w-full overflow-x-auto">
        <table className="w-full min-w-[820px] text-right text-sm">
          <thead className="bg-secondary/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <tr className="[&>th]:px-4 [&>th]:py-2.5">
              <th className="w-32">الرقم</th>
              <th className="w-28">النوع</th>
              <th className="w-28">التاريخ</th>
              <th className="w-20 text-center">البنود</th>
              <th className="w-32 text-left">الإجمالي</th>
              <th className="w-32 text-left">المدفوع</th>
              <th className="w-32 text-left">المتبقي</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {invs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-xs text-muted-foreground">
                  لا توجد فواتير.
                </td>
              </tr>
            )}
            {invs.map((i) => {
              const t = invoiceTotal(i);
              const paid = paidByInvoice.get(i.id) ?? 0;
              const r = Math.max(0, t - paid);
              const label = i.type === "entry" ? "شراء" : i.type === "return" ? "مرتجع" : "بيع";
              return (
                <tr
                  key={i.id}
                  onClick={() => navigate({ to: "/invoices/$id", params: { id: i.id } })}
                  className="h-12 cursor-pointer align-middle hover:bg-secondary/40 [&>td]:px-4 [&>td]:py-2"
                >
                  <td className="tabular-nums font-semibold text-primary">{i.number}</td>
                  <td className="text-xs text-muted-foreground">{label}</td>
                  <td className="tabular-nums text-muted-foreground">{i.date}</td>
                  <td className="text-center tabular-nums">{i.lines.length}</td>
                  <td className="text-left tabular-nums">
                    {fmt(t)}{" "}
                    <span className="text-[10px] text-muted-foreground">
                      {currencySymbol(i.currency)}
                    </span>
                  </td>
                  <td className="text-left tabular-nums text-muted-foreground">
                    {fmt(paid)}{" "}
                    <span className="text-[10px] text-muted-foreground">
                      {currencySymbol(i.currency)}
                    </span>
                  </td>
                  <td
                    className={`text-left font-semibold tabular-nums ${
                      r > 0 ? "text-warning" : "text-success"
                    }`}
                  >
                    {fmt(r)}{" "}
                    <span className="text-[10px] text-muted-foreground">
                      {currencySymbol(i.currency)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </PageCard>
  );
}

/* ---------------- Payments ---------------- */

function PaymentsTab({ p }: { p: Party }) {
  const [payFor, setPayFor] = useState<string>("");
  const [amount, setAmount] = useState("");
  const cur = currencySymbol(p.currency ?? "SYP");
  const createReceipt = useCreateReceiptVoucher();

  const { data: invData } = useInvoicesList();
  const invs = (invData?.data ?? []).filter((i) => i.partyId === p.id && i.status === "active");
  const openInvs = invs.filter((i) => invoiceRemaining(invoiceTotal(i), 0) > 0);
  const { data: vData } = useVouchersList();
  // BUG-9 fix: show actual payment/receipt vouchers linked to this party.
  const payments = (vData?.data ?? [])
    .filter(
      (v) =>
        v.partyId === p.id &&
        v.status === "active" &&
        (v.kind === "receipt" || v.kind === "payment"),
    )
    .map((v) => {
      const inv = invs.find((i) => i.id === v.invoiceId);
      return {
        date: v.date ?? new Date().toISOString().slice(0, 10),
        amount: v.amount,
        currency: v.currency ?? "SYP",
        kind: v.kind,
        number: v.number,
        invoice: inv?.number ?? "—",
        invoiceId: v.invoiceId ?? "",
        method: v.method ?? "—",
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const submit = async () => {
    const inv = openInvs.find((i) => i.id === payFor);
    const n = Number(amount);
    if (!payFor || !n || n <= 0) return;
    await createReceipt.mutateAsync({
      kind: "receipt",
      date: new Date().toISOString().slice(0, 10),
      partyId: p.id,
      partyKind: "customer",
      invoiceId: payFor,
      amount: n,
      currency: (inv?.currency ?? p.currency ?? "SYP") as Currency,
      method: "cash",
    });
    setPayFor("");
    setAmount("");
  };

  return (
    <div className="space-y-4">
      <PageCard title="تسجيل دفعة" description="أضف دفعة على أي فاتورة مفتوحة." tone="primary">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <div>
            <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              الفاتورة
            </Label>
            <Select value={payFor} onValueChange={setPayFor}>
              <SelectTrigger className="!h-10">
                <SelectValue placeholder="اختر فاتورة مفتوحة" />
              </SelectTrigger>
              <SelectContent>
                {openInvs.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    لا توجد فواتير مفتوحة.
                  </div>
                )}
                {openInvs.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.number} — متبقي {fmt(invoiceRemaining(invoiceTotal(i), 0))}{" "}
                    {currencySymbol(i.currency)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              المبلغ
            </Label>
            <Input
              type="number"
              className="h-10 tabular-nums"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="flex items-end">
            <Button
              onClick={submit}
              className="h-10 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> تسجيل الدفعة
            </Button>
          </div>
        </div>
      </PageCard>

      <PageCard
        title="سجل الدفعات"
        description="جميع سندات القبض والصرف المرتبطة بهذا الحساب."
        noBodyPadding
      >
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[700px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <tr className="[&>th]:px-4 [&>th]:py-2.5">
                <th className="w-32">التاريخ</th>
                <th className="w-32">السند</th>
                <th className="w-24">النوع</th>
                <th className="w-24">الطريقة</th>
                <th className="w-32">الفاتورة</th>
                <th className="text-left">المبلغ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {payments.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-xs text-muted-foreground">
                    لا توجد دفعات مسجلة بعد.
                  </td>
                </tr>
              )}
              {payments.map((pay, idx) => (
                <tr key={idx} className="h-12 align-middle [&>td]:px-4 [&>td]:py-2">
                  <td className="tabular-nums text-muted-foreground">{pay.date}</td>
                  <td className="tabular-nums font-semibold text-primary">{pay.number ?? "—"}</td>
                  <td className="text-xs text-muted-foreground">
                    {pay.kind === "receipt" ? "قبض" : pay.kind === "payment" ? "صرف" : pay.kind}
                  </td>
                  <td className="text-xs text-muted-foreground">{pay.method}</td>
                  <td className="tabular-nums text-primary">{pay.invoice}</td>
                  <td className="text-left font-semibold tabular-nums">
                    {fmt(pay.amount)}{" "}
                    <span className="text-[10px] text-muted-foreground">
                      {currencySymbol(pay.currency as Currency)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageCard>
    </div>
  );
}

/* ---------------- Statement of Account ---------------- */

function StatementTab({ p, kind }: { p: Party; kind: PartyKind }) {
  const navigate = useNavigate();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState<LedgerType | "all">("all");
  const [ccy, setCcy] = useState<Currency>(p.currency ?? "SYP");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmSettle, setConfirmSettle] = useState(false);

  const filter = {
    from: from || undefined,
    to: to || undefined,
    type: type === "all" ? undefined : type,
    currency: ccy,
  };

  const { data: statement, isLoading } = useStatement(p.id, kind, filter);
  const settle = useSettleParty(p.id, kind);

  const rows = statement?.entries ?? [];
  const previousBalance = statement?.previousBalance ?? 0;
  const totalDebit = statement?.totalDebit ?? 0;
  const totalCredit = statement?.totalCredit ?? 0;
  const finalBalance = statement?.finalBalance ?? 0;
  const currency = statement?.currency ?? p.currency ?? "SYP";
  const cur = currencySymbol(currency);

  const toggleRow = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const spendable = (r: (typeof rows)[number]) => Array.isArray(r.lines) && r.lines.length > 0;

  const exportCsv = () => {
    const header = [
      "#",
      "التاريخ",
      "النوع",
      "المرجع",
      "البيان",
      "الكمية",
      "السعر",
      "مدين",
      "دائن",
      "الرصيد",
    ];
    const body: string[][] = [];
    if (previousBalance !== 0 || rows.length > 0) {
      body.push(["", "—", "رصيد سابق", "", "", "", "", "", "", String(previousBalance)]);
    }
    rows.forEach((r) => {
      body.push([
        String(r.seq),
        r.date,
        `${LEDGER_TYPE_LABEL[r.type] ?? r.type}${r.status === "cancelled" ? " (ملغاة)" : ""}`,
        r.referenceNumber ?? "",
        r.description ?? "",
        r.quantityKg ? String(r.quantityKg) : "",
        r.pricePerKg ? String(r.pricePerKg) : "",
        String(Math.round(r.debit)),
        String(Math.round(r.credit)),
        String(Math.round(r.runningBalance)),
      ]);
    });
    body.push([
      "",
      "",
      "الإجمالي",
      "",
      "",
      "",
      "",
      String(Math.round(totalDebit)),
      String(Math.round(totalCredit)),
      String(Math.round(finalBalance)),
    ]);
    const csv = [header, ...body]
      .map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `statement-${p.code ?? p.id}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const printDoc = (
    <PartyStatementDocument
      partyName={p.name}
      partyCode={p.code}
      period={`${(statement?.fromDate ?? from) || "البداية"} — ${
        (statement?.toDate ?? to) || "اليوم"
      }`}
      currency={cur}
      previousBalance={previousBalance}
      rows={rows.map((r) => ({
        seq: r.seq,
        date: r.date,
        type: r.type,
        referenceNumber: r.referenceNumber,
        description: r.description ?? "",
        quantityKg: r.quantityKg ?? 0,
        pricePerKg: r.pricePerKg ?? 0,
        debit: r.debit,
        credit: r.credit,
        runningBalance: r.runningBalance,
        status: r.status,
      }))}
      totals={{ debit: totalDebit, credit: totalCredit, running: finalBalance }}
    />
  );

  return (
    <div className="space-y-4">
      <PageCard title="مرشحات كشف الحساب" description="حدد الفترة والنوع والعملة." tone="primary">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              من تاريخ
            </Label>
            <Input
              type="date"
              className="h-10 tabular-nums"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              إلى تاريخ
            </Label>
            <Input
              type="date"
              className="h-10 tabular-nums"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div>
            <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              نوع الحركة
            </Label>
            <Select value={type} onValueChange={(v) => setType(v as LedgerType | "all")}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الحركات</SelectItem>
                {Object.entries(LEDGER_TYPE_LABEL).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
              العملة
            </Label>
            <Select value={ccy} onValueChange={(v) => setCcy(v as Currency)}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SYP">ل.س</SelectItem>
                <SelectItem value="USD">$ دولار</SelectItem>
                <SelectItem value="EUR">€ يورو</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" className="h-9 gap-2" onClick={() => printDocument(printDoc)}>
            <Printer className="h-4 w-4" /> طباعة / PDF
          </Button>
          <Button variant="outline" className="h-9 gap-2" onClick={exportCsv}>
            <Download className="h-4 w-4" /> تصدير Excel
          </Button>
          {finalBalance !== 0 && (
            <Button
              variant="default"
              className="h-9 gap-2 bg-warning text-warning-foreground hover:bg-warning/90"
              onClick={() => setConfirmSettle(true)}
              disabled={settle.isPending}
            >
              <Scale className="h-4 w-4" /> تسوية الحساب
            </Button>
          )}
        </div>
      </PageCard>

      {isLoading && rows.length === 0 ? (
        <PageCard title="كشف الحساب">
          <div className="py-10 text-center text-xs text-muted-foreground">جارٍ تحميل الكشف…</div>
        </PageCard>
      ) : (
        <PageCard
          title="كشف الحساب"
          description={`الحركات المحاسبية — ${rows.length} حركة.`}
          noBodyPadding={false}
        >
          {/* Summary */}
          <div className="grid gap-3 px-4 pb-4 md:grid-cols-4">
            {[
              { label: "رصيد سابق", value: previousBalance },
              { label: "إجمالي مدين", value: totalDebit },
              { label: "إجمالي دائن", value: totalCredit },
              { label: "الرصيد النهائي", value: finalBalance, bold: true },
            ].map((s) => (
              <div
                key={s.label}
                className={`rounded-lg border px-4 py-3 ${
                  s.bold ? "border-primary/30 bg-primary/5" : "border-border bg-background/60"
                }`}
              >
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {s.label}
                </div>
                <div
                  className={`mt-1 text-sm font-bold tabular-nums ${
                    s.bold ? (s.value > 0 ? "text-warning" : s.value < 0 ? "text-success" : "") : ""
                  }`}
                >
                  {fmt(s.value)} {cur}
                </div>
              </div>
            ))}
          </div>

          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[1060px] text-right text-sm">
              <thead className="bg-secondary/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <tr className="[&>th]:px-3 [&>th]:py-2.5">
                  <th className="w-10">#</th>
                  <th className="w-28">التاريخ</th>
                  <th className="w-32">النوع</th>
                  <th className="w-28">المرجع</th>
                  <th className="min-w-[180px]">البيان</th>
                  <th className="w-20 text-left">الكمية</th>
                  <th className="w-24 text-left">السعر</th>
                  <th className="w-28 text-left">مدين</th>
                  <th className="w-28 text-left">دائن</th>
                  <th className="w-32 text-left">الرصيد</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {previousBalance !== 0 && (
                  <tr className="h-11 bg-muted/40 align-middle [&>td]:px-3 [&>td]:py-2">
                    <td className="tabular-nums text-muted-foreground">—</td>
                    <td className="tabular-nums text-muted-foreground">—</td>
                    <td className="text-xs font-semibold">رصيد سابق</td>
                    <td colSpan={4} className="text-muted-foreground">
                      أرصدة قبل تاريخ البداية
                    </td>
                    <td className="text-left tabular-nums" />
                    <td className="text-left tabular-nums" />
                    <td
                      className={`text-left font-semibold tabular-nums ${
                        previousBalance > 0
                          ? "text-warning"
                          : previousBalance < 0
                            ? "text-success"
                            : ""
                      }`}
                    >
                      {fmt(previousBalance)}
                    </td>
                    <td />
                  </tr>
                )}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={11}
                      className="px-4 py-10 text-center text-xs text-muted-foreground"
                    >
                      لا حركات في هذه الفترة.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      className={`h-11 cursor-pointer align-middle [&>td]:px-3 [&>td]:py-2 ${
                        r.status === "cancelled"
                          ? "bg-destructive/5 text-muted-foreground"
                          : "hover:bg-secondary/30"
                      }`}
                      onClick={() => {
                        if (r.referenceType === "invoice" && r.referenceId) {
                          navigate({ to: "/invoices/$id", params: { id: r.referenceId } });
                        }
                      }}
                    >
                      <td className="tabular-nums text-muted-foreground">{r.seq}</td>
                      <td className="tabular-nums text-muted-foreground">
                        {r.type === "opening" ? "—" : r.date}
                      </td>
                      <td className="text-xs">
                        {LEDGER_TYPE_LABEL[r.type] ?? r.type}
                        {r.status === "cancelled" && (
                          <span className="mr-1 rounded bg-destructive/10 px-1 py-0.5 text-[9px] font-semibold text-destructive">
                            ملغاة
                          </span>
                        )}
                      </td>
                      <td
                        className={`tabular-nums text-primary ${
                          r.status === "cancelled" ? "line-through" : ""
                        }`}
                      >
                        {r.referenceNumber}
                      </td>
                      <td className="text-muted-foreground">{r.description}</td>
                      <td
                        className={`text-left tabular-nums ${
                          r.status === "cancelled" ? "line-through" : ""
                        }`}
                      >
                        {r.quantityKg ? `${fmt(r.quantityKg)} كجم` : "—"}
                      </td>
                      <td
                        className={`text-left tabular-nums ${
                          r.status === "cancelled" ? "line-through" : ""
                        }`}
                      >
                        {r.pricePerKg ? fmt(r.pricePerKg) : "—"}
                      </td>
                      <td
                        className={`text-left tabular-nums ${
                          r.status === "cancelled" ? "line-through" : ""
                        }`}
                      >
                        {r.debit ? fmt(r.debit) : "—"}
                      </td>
                      <td
                        className={`text-left tabular-nums ${
                          r.status === "cancelled" ? "line-through" : ""
                        }`}
                      >
                        {r.credit ? fmt(r.credit) : "—"}
                      </td>
                      <td
                        className={`text-left font-semibold tabular-nums ${
                          r.status === "cancelled"
                            ? "line-through"
                            : r.runningBalance > 0
                              ? "text-warning"
                              : r.runningBalance < 0
                                ? "text-success"
                                : ""
                        }`}
                      >
                        {fmt(r.runningBalance)}
                      </td>
                      <td className="text-left">
                        {spendable(r) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => toggleRow(r.id)}
                          >
                            <ChevronDown
                              className={`h-4 w-4 transition-transform ${
                                expanded.has(r.id) ? "rotate-180" : ""
                              }`}
                            />
                          </Button>
                        )}
                      </td>
                    </tr>
                    {expanded.has(r.id) && r.lines && (
                      <tr className="bg-muted/30 align-middle [&>td]:px-3 [&>td]:py-2">
                        <td colSpan={11}>
                          <div className="mb-1 mt-1 rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              تفاصيل الأصناف
                            </div>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground [&>th]:px-2 [&>th]:py-1">
                                  <th className="text-right">الخامة</th>
                                  <th className="text-right">اللون</th>
                                  <th className="text-right">اللفة</th>
                                  <th className="text-left">الكمية</th>
                                  <th className="text-left">السعر</th>
                                  <th className="text-left">الإجمالي</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.lines.map((l) => (
                                  <tr key={l.lineId} className="[&>td]:px-2 [&>td]:py-1">
                                    <td className="text-right font-medium">{l.fabricName}</td>
                                    <td className="text-right">{l.colorName}</td>
                                    <td className="text-right tabular-nums text-primary">
                                      {l.rollNo ?? "—"}
                                    </td>
                                    <td className="text-left tabular-nums">
                                      {fmt(l.quantityKg)} كجم
                                    </td>
                                    <td className="text-left tabular-nums">{fmt(l.pricePerKg)}</td>
                                    <td className="text-left tabular-nums">{fmt(l.amount)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot className="bg-secondary/40 text-xs font-bold">
                  <tr className="[&>td]:px-3 [&>td]:py-2.5">
                    <td colSpan={2} className="text-left" />
                    <td colSpan={5} className="text-left">
                      الإجمالي
                    </td>
                    <td className="text-left tabular-nums">{fmt(totalDebit)}</td>
                    <td className="text-left tabular-nums">{fmt(totalCredit)}</td>
                    <td
                      className={`text-left tabular-nums ${
                        finalBalance > 0 ? "text-warning" : finalBalance < 0 ? "text-success" : ""
                      }`}
                    >
                      {fmt(finalBalance)} {cur}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </PageCard>
      )}

      {/* Settle confirmation */}
      <AlertDialog open={confirmSettle} onOpenChange={setConfirmSettle}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>تسوية الحساب</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم إنشاء سند تسوية بمبلغ {fmt(Math.abs(finalBalance))} {cur} لإلغاء الرصيد الحالي (
              {finalBalance > 0 ? "مدين" : "دائن"}). هل أنت متأكد؟
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                settle.mutate(
                  { currency: ccy },
                  {
                    onSettled: () => setConfirmSettle(false),
                  },
                );
              }}
            >
              {settle.isPending ? "جارٍ التسوية…" : "تأكيد التسوية"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ---------------- Outstanding ---------------- */

function OutstandingTab({ p }: { p: Party }) {
  const { data: invData } = useInvoicesList();
  const invs = invData?.data ?? [];
  const { data: vData } = useVouchersList();
  const vchs = vData?.data ?? [];
  // Currency-filtered outstanding (same pattern as BUG-06 fix) —
  // avoids mixing SYP+USD+EUR into meaningless blended totals.
  const rows = buildOutstanding(p.id, invs, vchs, p.currency ?? "SYP");
  const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 } as Record<
    "0-30" | "31-60" | "61-90" | "90+",
    number
  >;
  rows.forEach((r) => (buckets[r.bucket] += r.remaining));
  const cur = currencySymbol(p.currency ?? "SYP");

  return (
    <div className="space-y-4">
      <PageCard
        title="تحليل التقادم"
        description="توزيع الرصيد المستحق حسب عمر الفاتورة."
        tone="primary"
      >
        <div className="grid gap-3 md:grid-cols-4">
          {(["0-30", "31-60", "61-90", "90+"] as const).map((b) => (
            <div key={b} className="rounded-lg border border-primary/20 bg-background/60 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {b === "90+" ? "أكثر من 90 يوم" : `${b} يوم`}
              </div>
              <div
                className={`mt-1 text-lg font-bold tabular-nums ${
                  b === "90+"
                    ? "text-destructive"
                    : b === "61-90"
                      ? "text-warning"
                      : "text-foreground"
                }`}
              >
                {fmt(buckets[b])}
                <span className="mr-1 text-xs font-normal opacity-70">{cur}</span>
              </div>
            </div>
          ))}
        </div>
      </PageCard>

      <PageCard
        title="الفواتير المفتوحة"
        description="الفواتير التي لم تسدد بالكامل."
        noBodyPadding
      >
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[820px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                <th className="w-32">الرقم</th>
                <th className="w-28">التاريخ</th>
                <th className="w-24 text-center">العمر</th>
                <th className="w-28 text-center">الفئة</th>
                <th className="w-32 text-left">الإجمالي</th>
                <th className="w-32 text-left">المدفوع</th>
                <th className="w-32 text-left">المتبقي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-xs text-muted-foreground">
                    لا رصيد مستحق — الحساب مسدّد بالكامل.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.invoiceId} className="h-11 align-middle [&>td]:px-3 [&>td]:py-2">
                  <td className="tabular-nums font-semibold text-primary">{r.number}</td>
                  <td className="tabular-nums text-muted-foreground">{r.date}</td>
                  <td className="text-center tabular-nums">{r.ageDays} يوم</td>
                  <td className="text-center">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-semibold ${
                        r.bucket === "90+"
                          ? "bg-destructive/15 text-destructive"
                          : r.bucket === "61-90"
                            ? "bg-warning/15 text-warning"
                            : "bg-secondary text-muted-foreground"
                      }`}
                    >
                      {r.bucket}
                    </span>
                  </td>
                  <td className="text-left tabular-nums">{fmt(r.total)}</td>
                  <td className="text-left tabular-nums text-muted-foreground">{fmt(r.paid)}</td>
                  <td className="text-left font-semibold tabular-nums text-warning">
                    {fmt(r.remaining)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageCard>
    </div>
  );
}

/* ---------------- Stats / History ---------------- */

function StatsTab({ p, kind }: { p: Party; kind: PartyKind }) {
  const { data: invData } = useInvoicesList();
  const invs = invData?.data ?? [];
  const { data: vData } = useVouchersList();
  const vchs = vData?.data ?? [];
  const colorNames = Object.fromEntries(colors.map((c) => [c.id, c.name]));
  const colorCodes = Object.fromEntries(colors.map((c) => [c.id, c.code ?? ""]));
  const fabricNames = Object.fromEntries(fabrics.map((f) => [f.id, f.name]));
  const hist = buildFabricHistory(p.id, kind, invs, colorNames, colorCodes, fabricNames);
  const stats = buildPartyStats(p, kind, invs, vchs, p.currency ?? "SYP");
  const topRows = [...hist].sort((a, b) => b.totalKg - a.totalKg);
  const topFabric = topRows[0]?.fabricName;
  const topColor = topRows[0]?.colorName;
  const topDye = topRows[0]?.dyeBatch;
  const cur = currencySymbol(p.currency ?? "SYP");
  const isSup = kind === "supplier";

  return (
    <div className="space-y-4">
      <PageCard
        title="أفضل الأصناف"
        description="أعلى قماش/لون/دفعة صبغ تم التعامل بها."
        tone="primary"
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Kpi label="القماش الأكثر تعاملاً" value={topFabric ?? "—"} />
          <Kpi label="اللون الأكثر تعاملاً" value={topColor ?? "—"} />
          <Kpi label="رقم الصبغة الأكثر تعاملاً" value={topDye ?? "—"} />
          <Kpi label="إجمالي الوزن" value={`${fmt(stats.totalKg)} كغ`} />
          <Kpi
            label={isSup ? "متوسط سعر الشراء" : "متوسط سعر البيع"}
            value={stats.totalKg > 0 ? fmt(stats.totalAmount / stats.totalKg) : "—"}
            suffix={cur}
          />
          <Kpi label="متوسط قيمة الفاتورة" value={fmt(stats.avgInvoice)} suffix={cur} />
        </div>
      </PageCard>

      <PageCard
        title={isSup ? "سجل المشتريات التفصيلي" : "سجل المبيعات التفصيلي"}
        description="تجميع حسب القماش + اللون + دفعة الصبغ."
        noBodyPadding
      >
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[820px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                <th className="min-w-[140px]">القماش</th>
                <th className="min-w-[140px]">اللون</th>
                <th className="w-28">دفعة الصبغ</th>
                <th className="w-24 text-center">تكرار</th>
                <th className="w-28 text-left">الكمية (كغ)</th>
                <th className="w-32 text-left">{isSup ? "متوسط الشراء" : "متوسط البيع"}</th>
                <th className="w-32 text-left">الإجمالي</th>
                <th className="w-28">آخر عملية</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {hist.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-xs text-muted-foreground">
                    لا سجل تعامل بعد.
                  </td>
                </tr>
              )}
              {hist.map((r) => (
                <tr key={r.key} className="h-11 align-middle [&>td]:px-3 [&>td]:py-2">
                  <td className="font-semibold">{r.fabricName}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <span>{r.colorName}</span>
                      <span className="text-[10px] text-muted-foreground">({r.colorCode})</span>
                    </div>
                  </td>
                  <td className="tabular-nums text-muted-foreground">{r.dyeBatch}</td>
                  <td className="text-center tabular-nums">{r.invoicesCount}</td>
                  <td className="text-left tabular-nums">{fmt(r.totalKg)}</td>
                  <td className="text-left tabular-nums">{fmt(r.avgPrice)}</td>
                  <td className="text-left font-semibold tabular-nums">{fmt(r.totalAmount)}</td>
                  <td className="tabular-nums text-muted-foreground">{r.lastDate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageCard>
    </div>
  );
}

/* ---------------- Attachments ---------------- */

function AttachmentsTab({ p }: { p: Party }) {
  const [name, setName] = useState("");
  const list = p.attachments ?? [];

  const add = () => {
    if (!name.trim()) return;
    addPartyAttachment(p.id, {
      name: name.trim(),
      size: Math.floor(Math.random() * 900_000) + 100_000,
    });
    setName("");
  };

  return (
    <div className="space-y-4">
      <PageCard
        title="إضافة مرفق"
        description="سجل اسم الوثيقة أو العقد (تخزين تجريبي)."
        tone="primary"
      >
        <div className="flex gap-2">
          <Input
            className="h-10"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="اسم الملف، مثال: عقد توريد 2026.pdf"
          />
          <Button
            onClick={add}
            className="h-10 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> إضافة
          </Button>
        </div>
      </PageCard>

      <PageCard title="المرفقات" description="جميع الوثائق المرتبطة بهذا الحساب." noBodyPadding>
        <div className="divide-y divide-border">
          {list.length === 0 && (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              لا توجد مرفقات بعد.
            </div>
          )}
          {list.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-4 py-3">
              <div className="grid h-9 w-9 place-items-center rounded-md bg-secondary text-muted-foreground">
                <Paperclip className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-foreground">{a.name}</div>
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  {(a.size / 1024).toFixed(1)} كيلوبايت · {a.uploadedAt.slice(0, 10)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => removePartyAttachment(p.id, a.id)}
                className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label="حذف"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </PageCard>
    </div>
  );
}

/* ---------------- Notes ---------------- */

function NotesTab({ p, kind }: { p: Party; kind: PartyKind }) {
  const [text, setText] = useState(p.notes ?? "");
  const save = () => {
    if (kind === "supplier") updateSupplier(p.id, { notes: text });
    else updateCustomer(p.id, { notes: text });
  };
  return (
    <PageCard title="ملاحظات الحساب" description="ملاحظات داخلية لفريق العمل.">
      <Textarea
        rows={8}
        className="resize-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="اكتب ملاحظاتك هنا..."
      />
      <div className="mt-3 flex justify-end">
        <Button
          onClick={save}
          className="h-10 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          حفظ الملاحظات
        </Button>
      </div>
    </PageCard>
  );
}

/* ---------------- Activity ---------------- */

/** Derive activity timeline from real data sources (invoices, vouchers, party changes)
 *  — avoids a non-existent activity table. Sorted newest-first. */
function ActivityTab({ p, kind }: { p: Party; kind: PartyKind }) {
  const { data: invData } = useInvoicesList();
  const invs = (invData?.data ?? []).filter((i) => i.partyId === p.id && i.status !== "cancelled");
  const { data: vData } = useVouchersList();
  const vchs = (vData?.data ?? []).filter((v) => v.partyId === p.id && v.status === "active");

  const items: {
    id: string;
    kind: "invoice" | "payment" | "updated" | "created";
    message: string;
    at: string;
    currency?: string;
    amount?: number;
  }[] = [];

  // Party creation
  items.push({
    id: `party-${p.id}`,
    kind: "created",
    message: `تم إنشاء الحساب (${p.code ?? "—"})`,
    at: p.createdAt ?? "",
  });

  // Invoices (sales/entries/returns)
  for (const inv of invs) {
    const label = inv.type === "entry" ? "شراء" : inv.type === "return" ? "مرتجع" : "بيع";
    items.push({
      id: `inv-${inv.id}`,
      kind: "invoice",
      message: `${label} ${inv.number} — ${fmt(invoiceTotal(inv))} ${currencySymbol(inv.currency)}`,
      at: inv.date + "T00:00:00",
      currency: inv.currency,
      amount: invoiceTotal(inv),
    });
  }

  // Vouchers (receipts/payments)
  for (const v of vchs) {
    const label = v.kind === "receipt" ? "قبض" : v.kind === "payment" ? "صرف" : v.kind;
    items.push({
      id: `vch-${v.id}`,
      kind: "payment",
      message: `${label} ${v.number ?? ""} — ${fmt(v.amount)} ${currencySymbol(v.currency ?? "SYP")} ${v.invoiceId ? "على فاتورة" : ""}`,
      at: (v.date ?? "") + "T00:00:00",
      currency: v.currency ?? "SYP",
      amount: v.amount,
    });
  }

  // Sort newest-first
  items.sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <PageCard
      title="سجل النشاط"
      description="جميع العمليات المسجلة على هذا الحساب مباشرةً من الفواتير والسندات."
      noBodyPadding
    >
      <div className="divide-y divide-border">
        {items.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-muted-foreground">لا نشاط بعد.</div>
        )}
        {items.map((a) => (
          <div key={a.id} className="flex items-start gap-3 px-4 py-3">
            <div
              className={`mt-0.5 grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold ${
                a.kind === "invoice"
                  ? "bg-primary/15 text-primary"
                  : a.kind === "payment"
                    ? "bg-success/15 text-success"
                    : a.kind === "updated"
                      ? "bg-warning/15 text-warning"
                      : "bg-secondary text-muted-foreground"
              }`}
            >
              {a.kind === "invoice"
                ? "ف"
                : a.kind === "payment"
                  ? "د"
                  : a.kind === "updated"
                    ? "ت"
                    : "•"}
            </div>
            <div className="flex-1">
              <div className="text-sm text-foreground">{a.message}</div>
              <div className="text-[11px] tabular-nums text-muted-foreground">
                {a.at ? new Date(a.at).toLocaleString("ar-SY") : "—"}
              </div>
            </div>
          </div>
        ))}
      </div>
    </PageCard>
  );
}

/* ---------------- shared bits ---------------- */

function Kpi({
  label,
  value,
  suffix,
  tone = "muted",
}: {
  label: string;
  value: string;
  suffix?: string;
  tone?: "muted" | "warn" | "good";
}) {
  const color =
    tone === "warn" ? "text-warning" : tone === "good" ? "text-success" : "text-foreground";
  return (
    <div className="rounded-lg border border-primary/20 bg-background/60 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${color}`}>
        {value}
        {suffix && <span className="mr-1 text-xs font-normal opacity-70">{suffix}</span>}
      </div>
    </div>
  );
}

function Info({
  label,
  value,
  className = "",
}: {
  label: string;
  value?: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-foreground">{value?.toString().trim() || "—"}</dd>
    </div>
  );
}
