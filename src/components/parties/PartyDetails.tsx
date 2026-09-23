import { Fragment, useEffect, useState } from "react";
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
import { printDocument, printDataChanged, printOrArchive } from "@/components/print/printPortal";
import { PartyStatementDocument } from "@/components/print/PartyStatementDocument";
import { InvoicePrintDocument } from "@/components/print/InvoicePrintDocument";
import { archiveMeta } from "@/shared/utils/documentArchive";
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
  customers,
  deleteCustomer,
  deleteSupplier,
  removePartyAttachment,
  supplierById,
  suppliers,
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
import { useCancelInvoice, useInvoicesList, type Invoice } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useReturnsList, returnAmount } from "@/presentation/hooks/useReturns";
import { invoiceTotal } from "@/core/calculations/invoiceCalc";
import {
  buildFabricHistory,
  buildOutstanding,
  buildPartyStats,
  buildPartyStatsByCurrency,
  ledgerRemainingByCurrency,
  LEDGER_TYPE_LABEL,
  useLedgerEntries,
  type LedgerType,
} from "@/presentation/hooks/useLedger";
import { useStatement } from "@/presentation/hooks/useStatement";
import { SettlementDialog } from "@/components/parties/SettlementDialog";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";
import {
  statementOriginalAmount,
  statementPaymentNote,
  statementRateToShow,
} from "@/lib/statementDocument";

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

/** Symbol on the left, amount on the right — never mixed across currencies. */
function MoneyText({
  amount,
  currency,
  className,
}: {
  amount: number;
  currency?: Currency | "";
  className?: string;
}) {
  const sym = currency ? currencySymbol(currency) : "";
  return (
    <span
      dir="ltr"
      className={`inline-flex items-baseline justify-end gap-1 tabular-nums ${className ?? ""}`}
    >
      {sym ? <span className="shrink-0 text-[0.7em] font-medium opacity-70">{sym}</span> : null}
      <span>{fmt(amount)}</span>
    </span>
  );
}

function isInvoiceStatementRow(r: { referenceType?: string; referenceId?: string }) {
  if (!r.referenceId) return false;
  const t = r.referenceType ?? "";
  return (
    t === "invoice" ||
    t === "sales_invoice" ||
    t === "purchase_invoice" ||
    t === "sales_invoice_cancel" ||
    t === "purchase_invoice_cancel"
  );
}

function printPartyInvoice(inv: Invoice) {
  const node = <InvoicePrintDocument invoice={inv} />;
  if (inv.type === "sale" || inv.type === "entry") {
    const party =
      inv.type === "sale"
        ? customers.find((c) => c.id === inv.partyId)
        : suppliers.find((s) => s.id === inv.partyId);
    printOrArchive(
      node,
      archiveMeta(inv.type, {
        date: inv.date,
        partyName: party?.name,
        number: inv.number || inv.reference || inv.id,
      }),
      true,
    );
  } else {
    printDocument(node);
  }
}

function StatementInvoiceActions({
  invoiceId,
  invoice,
  onDelete,
}: {
  invoiceId: string;
  invoice?: Invoice;
  onDelete: (inv: Invoice) => void;
}) {
  const cancelled = invoice?.status === "cancelled";
  const canEdit = !!invoice && !cancelled && (invoice.type === "sale" || invoice.type === "entry");
  return (
    <div
      className="inline-flex flex-nowrap items-center gap-1 whitespace-nowrap text-[11px] font-semibold"
      onClick={(e) => e.stopPropagation()}
    >
      <Link to="/invoices/$id" params={{ id: invoiceId }} className="text-primary hover:underline">
        عرض
      </Link>
      <span className="text-muted-foreground/50">|</span>
      {canEdit ? (
        <Link
          to={invoice.type === "entry" ? "/invoices/entry/new" : "/invoices/sale/new"}
          search={{ edit: invoice.id }}
          className="text-primary hover:underline"
        >
          تعديل
        </Link>
      ) : (
        <span className="text-muted-foreground/40">تعديل</span>
      )}
      <span className="text-muted-foreground/50">|</span>
      <button
        type="button"
        className="text-primary hover:underline disabled:text-muted-foreground/40"
        disabled={!invoice}
        onClick={() => invoice && printPartyInvoice(invoice)}
      >
        طباعة
      </button>
      <span className="text-muted-foreground/50">|</span>
      <button
        type="button"
        className="text-destructive hover:underline disabled:text-muted-foreground/40"
        disabled={!invoice || cancelled}
        onClick={() => invoice && onDelete(invoice)}
      >
        حذف
      </button>
    </div>
  );
}

/**
 * Extract the trailing integer from a human invoice number (e.g. "INV-2864" → 2864).
 * Used only as a deterministic tie-breaker when two invoices share the same date.
 */
function invoiceSeqNumber(n: string): number {
  const m = String(n).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : NaN;
}

export function PartyDetailsPage({ kind, id }: { kind: PartyKind; id: string }) {
  useInventory();
  useParties();
  const navigate = useNavigate();
  const isSup = kind === "supplier";
  const p: Party | undefined = isSup ? supplierById(id) : customerById(id);
  // H2 fix: aggregate the summary card from THIS party's full document set,
  // not page 1 of an unscoped global list. Both endpoints accept partyId +
  // limit (server caps at 1000), so the totals below are truly cumulative.
  const { data: invoicesData } = useInvoicesList(
    p ? { partyId: p.id, type: isSup ? "entry" : "sale", limit: 1000 } : undefined,
  );
  const allInvoices = invoicesData?.data ?? [];
  const { data: vouchersData } = useVouchersList(p ? { partyId: p.id, limit: 1000 } : undefined);
  const allVouchers = vouchersData?.data ?? [];
  const { data: returnsData } = useReturnsList(
    p ? { partyId: p.id, status: "active", limit: 1000 } : undefined,
  );
  const allReturns = (returnsData?.data ?? []).map((r) => ({
    originalInvoiceId: r.originalInvoiceId,
    status: r.status,
    currency: r.currency,
    amount: returnAmount(r),
  }));
  const { data: ledgerEntries = [] } = useLedgerEntries(
    p ? { partyId: p.id, limit: 1000 } : undefined,
  );

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

  const statsByCurrency = buildPartyStatsByCurrency(p, kind, allInvoices, allVouchers, allReturns);
  const ledgerRemaining = ledgerRemainingByCurrency(ledgerEntries, p.id, kind);
  const overviewStats = { ...statsByCurrency };
  for (const [ccy, remaining] of Object.entries(ledgerRemaining)) {
    const prev = overviewStats[ccy];
    overviewStats[ccy] = prev
      ? { ...prev, remaining }
      : {
          invoicesCount: 0,
          totalAmount: 0,
          totalPaid: 0,
          remaining,
          avgInvoice: 0,
          totalKg: 0,
          lastDate: undefined,
        };
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
        {Object.entries(overviewStats).length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            لا حركات مسجلة لهذا الحساب.
          </div>
        ) : (
          <div className="space-y-3">
            {Object.entries(overviewStats).map(([ccy, stats]) => {
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
      {tab === "payments" && <PaymentsTab p={p} kind={kind} />}
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
          void (async () => {
            try {
              if (isSup) await updateSupplier(p.id, mp as Parameters<typeof updateSupplier>[1]);
              else await updateCustomer(p.id, mp as Parameters<typeof updateCustomer>[1]);
              setEditing(false);
            } catch {
              /* toast already shown by hook */
            }
          })();
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
  // Issue 16(a): date-range filter on the party invoices view
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { data: invData } = useInvoicesList({
    partyId: p.id,
    limit: 1000,
    fromDate: from || undefined,
    toDate: to || undefined,
  });
  const invs = (invData?.data ?? [])
    .filter((i) => i.partyId === p.id && i.status !== "cancelled")
    .sort((a, b) => {
      // Issue 16(b): newest date first; same-day tie-break by invoice sequence desc
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      const sa = invoiceSeqNumber(a.number);
      const sb = invoiceSeqNumber(b.number);
      if (!Number.isNaN(sa) && !Number.isNaN(sb) && sa !== sb) return sa > sb ? -1 : 1;
      return b.number.localeCompare(a.number);
    });
  // Read paid from the invoice row (backend-maintained, FX-converted).
  const paidByInvoice = new Map<string, number>();
  for (const i of invs) {
    paidByInvoice.set(i.id, i.paid ?? 0);
  }

  return (
    <PageCard
      title={isSup ? "فواتير الشراء" : "فواتير البيع"}
      description="جميع الفواتير المرتبطة بهذا الحساب — الأحدث أولاً. يمكن تصفيتها بفترة زمنية."
      noBodyPadding
    >
      <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
        <div>
          <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
            من تاريخ
          </Label>
          <Input
            type="date"
            className="h-9 w-[160px] tabular-nums"
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
            className="h-9 w-[160px] tabular-nums"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        {(from || to) && (
          <Button
            type="button"
            variant="ghost"
            className="h-9 text-xs text-muted-foreground"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            مسح الفترة
          </Button>
        )}
      </div>
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

function PaymentsTab({ p, kind }: { p: Party; kind: PartyKind }) {
  const navigate = useNavigate();
  const isSup = kind === "supplier";
  const { data: invData } = useInvoicesList({ partyId: p.id, limit: 1000 });
  const { data: vData } = useVouchersList({ partyId: p.id, limit: 1000 });
  const invs = (invData?.data ?? []).filter((i) => i.partyId === p.id && i.status === "active");
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

  return (
    <div className="space-y-4">
      <PageCard
        title="تسجيل دفعة"
        description={
          isSup
            ? "يفتح سند صرف كامل (عملة + سعر صرف + فاتورة) — لا تسجيل مختصر من هنا."
            : "يفتح سند قبض كامل (عملة + سعر صرف + فاتورة) — لا تسجيل مختصر من هنا."
        }
        tone="primary"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() =>
              navigate({
                to: isSup ? "/payments/new" : "/receipts/new",
                search: { partyId: p.id },
              })
            }
            className="h-10 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" /> {isSup ? "سند صرف جديد" : "سند قبض جديد"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            اختر العملة وسعر الصرف والفاتورة في شاشة السند — هنا كان التسجيل بدون عملة فيرفض الحفظ.
          </p>
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

/**
 * Accounting side of a party balance for the KPI label. A customer with a
 * positive balance owes us (مدين); negative = we hold their money (دائن).
 * Suppliers are the mirror image. Falls back to the sign when the server did
 * not send `balanceSide` (older backend).
 */
function balanceSideLabel(
  side: "debit" | "credit" | "zero" | undefined,
  finalBalance: number,
  kind: "customer" | "supplier",
): string {
  const resolved =
    side ??
    (Math.abs(finalBalance) < 0.01
      ? "zero"
      : finalBalance > 0 === (kind === "customer")
        ? "debit"
        : "credit");
  if (resolved === "zero") return "متوازن";
  if (kind === "customer") {
    return resolved === "debit" ? "مدين (على العميل)" : "دائن (للعميل)";
  }
  return resolved === "credit" ? "دائن (للمورد)" : "مدين (على المورد)";
}

function StatementTab({ p, kind }: { p: Party; kind: PartyKind }) {
  const navigate = useNavigate();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState<LedgerType | "all">("all");
  // Default ALL so SYP invoices + USD receipts both appear — filtering to
  // party.currency alone was hiding whole document classes and looked like
  // "فقط آخر فاتورة".
  const [ccy, setCcy] = useState<Currency | "ALL">("ALL");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [settleOpen, setSettleOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Invoice | null>(null);
  const cancelInvoice = useCancelInvoice();
  const { data: invData } = useInvoicesList({ partyId: p.id, limit: 1000 });
  const { data: vDataForSettle } = useVouchersList({ partyId: p.id, limit: 1000 });
  const { data: returnsForSettle } = useReturnsList({
    partyId: p.id,
    status: "active",
    limit: 1000,
  });
  const invoicesById = new Map((invData?.data ?? []).map((i) => [i.id, i]));
  const outstandingForSettle = buildOutstanding(
    p.id,
    invData?.data ?? [],
    vDataForSettle?.data ?? [],
    undefined,
    (returnsForSettle?.data ?? []).map((r) => ({
      originalInvoiceId: r.originalInvoiceId,
      status: r.status,
      amount: returnAmount(r),
    })),
  );

  const filter = {
    from: from || undefined,
    to: to || undefined,
    type: type === "all" ? undefined : type,
    currency: ccy,
  };

  // #8: fingerprint of the active statement filters — when they change while
  // a print snapshot is open, the stale snapshot is closed with a notice.
  const printFilterKey = JSON.stringify({ from, to, type, ccy });
  useEffect(() => {
    printDataChanged(printFilterKey);
  }, [printFilterKey]);

  const { data: statement, isLoading } = useStatement(p.id, kind, filter);

  const rows = statement?.entries ?? [];
  const previousBalance = statement?.previousBalance ?? 0;
  const totalDebit = statement?.totalDebit ?? 0;
  const totalCredit = statement?.totalCredit ?? 0;
  const finalBalance = statement?.finalBalance ?? 0;
  const multiCcy = ccy === "ALL" || statement?.currency === "ALL";
  const totalsByCurrency = statement?.totalsByCurrency ?? {};
  const displayCcy: Currency =
    !multiCcy && statement?.currency && statement.currency !== "ALL"
      ? statement.currency
      : // `multiCcy` false already implies ccy !== "ALL" (it is derived from
        // it), so TS narrows ccy to Currency here; the runtime check is kept
        // via String() to stay defensive without the impossible comparison.
        !multiCcy && String(ccy) !== "ALL"
        ? ccy
        : (p.currency ?? "SYP");
  const cur = multiCcy ? "" : currencySymbol(displayCcy);
  // # date type ref actions desc [ccy] origAmount rate qty price debit credit balance chevron
  const colCount = multiCcy ? 15 : 14;
  // "كل العملات" zeroes the scalar totals (SYP + USD must never be one number), so the
  // footer lists one totals row per currency instead of a misleading 0 / 0 / 0.
  const footerTotals: Array<{
    currency: string;
    totalDebit: number;
    totalCredit: number;
    finalBalance: number;
  }> = multiCcy
    ? Object.entries(totalsByCurrency)
        .filter(([, t]) => t && (t.totalDebit !== 0 || t.totalCredit !== 0 || t.finalBalance !== 0))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, t]) => ({
          currency,
          totalDebit: t!.totalDebit,
          totalCredit: t!.totalCredit,
          finalBalance: t!.finalBalance,
        }))
    : [{ currency: "", totalDebit, totalCredit, finalBalance }];

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
      "العملة",
      "المبلغ الأصلي",
      "سعر الصرف",
      "الكمية",
      "السعر",
      "مدين",
      "دائن",
      "الرصيد",
    ];
    const body: string[][] = [];
    if (previousBalance !== 0 || rows.length > 0) {
      body.push([
        "",
        "—",
        "رصيد سابق",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        String(previousBalance),
      ]);
    }
    rows.forEach((r) => {
      body.push([
        String(r.seq),
        r.date,
        `${LEDGER_TYPE_LABEL[r.type] ?? r.type}${r.status === "cancelled" ? " (ملغاة)" : ""}`,
        r.referenceNumber ?? "",
        [
          r.description ?? "",
          statementPaymentNote(r.document, r.currency ?? "SYP", r.debit || r.credit),
        ]
          .filter(Boolean)
          .join(" — "),
        r.currency ?? "",
        statementOriginalAmount(r.document) ?? "",
        statementRateToShow(r.document) != null ? String(statementRateToShow(r.document)) : "",
        r.quantityKg ? String(r.quantityKg) : "",
        r.pricePerKg ? String(r.pricePerKg) : "",
        String(r.debit),
        String(r.credit),
        String(r.runningBalance),
      ]);
    });
    // One totals row per currency ("كل العملات" never blends SYP with USD).
    for (const t of footerTotals) {
      body.push([
        "",
        "",
        multiCcy ? `الإجمالي — ${t.currency}` : "الإجمالي",
        "",
        "",
        multiCcy ? t.currency : "",
        "",
        "",
        "",
        "",
        String(t.totalDebit),
        String(t.totalCredit),
        String(t.finalBalance),
      ]);
    }
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
      currency={multiCcy ? "متعدد" : cur}
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
        currencySymbol: multiCcy ? currencySymbol((r.currency as Currency) ?? "SYP") : undefined,
        originalAmount: statementOriginalAmount(r.document),
        exchangeRate:
          statementRateToShow(r.document) != null
            ? fmt(statementRateToShow(r.document) as number)
            : null,
        paymentNote: statementPaymentNote(r.document, r.currency ?? "SYP", r.debit || r.credit),
      }))}
      totals={{ debit: totalDebit, credit: totalCredit, running: finalBalance }}
      totalsByCurrency={
        multiCcy
          ? footerTotals.map((t) => ({
              symbol: currencySymbol(t.currency as Currency),
              debit: t.totalDebit,
              credit: t.totalCredit,
              running: t.finalBalance,
            }))
          : undefined
      }
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
            <Select value={ccy} onValueChange={(v) => setCcy(v as Currency | "ALL")}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">كل العملات (كل الفواتير والحركات)</SelectItem>
                <SelectItem value="SYP">ل.س</SelectItem>
                <SelectItem value="USD">$ دولار</SelectItem>
                <SelectItem value="EUR">€ يورو</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-9 gap-2"
            onClick={() =>
              printDocument(
                printDoc,
                printFilterKey,
                archiveMeta("statement", {
                  date: to || new Date().toISOString().slice(0, 10),
                  typeLabel: "STATEMENT",
                  number: p.code || p.id,
                }),
              )
            }
          >
            <Printer className="h-4 w-4" /> طباعة / PDF
          </Button>
          <Button variant="outline" className="h-9 gap-2" onClick={exportCsv}>
            <Download className="h-4 w-4" /> تصدير Excel
          </Button>
          {outstandingForSettle.length > 0 && (
            <Button
              variant="default"
              className="h-9 gap-2 bg-warning text-warning-foreground hover:bg-warning/90"
              onClick={() => setSettleOpen(true)}
            >
              <Scale className="h-4 w-4" /> تسجيل دفعة
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
          {multiCcy ? (
            <div className="space-y-3 px-4 pb-4">
              <p className="text-[11px] text-muted-foreground">
                عرض كل العملات — الرصيد الجاري لكل صف بعملته. لا يُخلط ل.س مع دولار في رقم واحد.
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                {Object.entries(totalsByCurrency)
                  .filter(
                    ([, t]) =>
                      t.previousBalance !== 0 ||
                      t.totalDebit !== 0 ||
                      t.totalCredit !== 0 ||
                      t.finalBalance !== 0,
                  )
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([c, t]) => {
                    const sym = currencySymbol(c as Currency);
                    return (
                      <div
                        key={c}
                        className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3"
                      >
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          الرصيد المستحق — {sym}
                        </div>
                        <div
                          className={`mt-1 text-sm font-bold tabular-nums ${
                            t.finalBalance > 0
                              ? "text-warning"
                              : t.finalBalance < 0
                                ? "text-success"
                                : ""
                          }`}
                        >
                          <MoneyText amount={t.finalBalance} currency={c as Currency} />
                        </div>
                        <div className="mt-0.5 text-[10px] font-semibold">
                          {balanceSideLabel(t.balanceSide, t.finalBalance, kind)}
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                          {kind === "customer" ? "المسحوبات" : "المشتريات"} {fmt(t.totalDebit)} ·{" "}
                          {kind === "customer" ? "المقبوضات" : "المدفوعات"} {fmt(t.totalCredit)}
                        </div>
                        {kind === "customer" && (t.availableCredit ?? 0) > 0 && (
                          <div className="mt-1 text-[10px] font-semibold text-success tabular-nums">
                            رصيد دائن متاح (دفعات مقدمة) {fmt(t.availableCredit ?? 0)} {sym}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div
              className={`grid gap-3 px-4 pb-4 ${kind === "customer" ? "md:grid-cols-5" : "md:grid-cols-4"}`}
            >
              {[
                { label: "رصيد سابق", value: previousBalance },
                {
                  label: kind === "customer" ? "إجمالي المسحوبات (مدين)" : "إجمالي مدين",
                  value: totalDebit,
                },
                {
                  label: kind === "customer" ? "إجمالي المقبوضات (دائن)" : "إجمالي دائن",
                  value: totalCredit,
                },
                {
                  label: `صافي الرصيد — ${balanceSideLabel(
                    totalsByCurrency[displayCcy]?.balanceSide,
                    finalBalance,
                    kind,
                  )}`,
                  value: finalBalance,
                  bold: true,
                },
                ...(kind === "customer"
                  ? [
                      {
                        label: "الرصيد الدائن المتاح (دفعات مقدمة)",
                        value: totalsByCurrency[displayCcy]?.availableCredit ?? 0,
                        credit: true,
                      },
                    ]
                  : []),
              ].map((s) => (
                <div
                  key={s.label}
                  className={`rounded-lg border px-4 py-3 ${
                    s.bold
                      ? "border-primary/30 bg-primary/5"
                      : "credit" in s && s.credit && s.value > 0
                        ? "border-success/30 bg-success/5"
                        : "border-border bg-background/60"
                  }`}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {s.label}
                  </div>
                  <div
                    className={`mt-1 text-sm font-bold tabular-nums ${
                      s.bold
                        ? s.value > 0
                          ? "text-warning"
                          : s.value < 0
                            ? "text-success"
                            : ""
                        : ""
                    }`}
                  >
                    <MoneyText amount={s.value} currency={multiCcy ? "" : displayCcy} />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[1560px] text-right text-sm">
              <thead className="bg-secondary/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <tr className="[&>th]:px-3 [&>th]:py-2.5">
                  <th className="w-10">#</th>
                  <th className="w-28">التاريخ</th>
                  <th className="w-32">النوع</th>
                  <th className="w-28">المرجع</th>
                  <th className="w-[200px]">إجراءات</th>
                  <th className="min-w-[200px]">البيان</th>
                  {multiCcy && <th className="w-16">العملة</th>}
                  <th className="w-28 text-left">المبلغ الأصلي</th>
                  <th className="w-24 text-left">سعر الصرف</th>
                  <th className="w-20 text-left">الكمية</th>
                  <th className="w-24 text-left">السعر</th>
                  <th className="w-28 text-left">مدين</th>
                  <th className="w-28 text-left">دائن</th>
                  <th className="w-32 text-left">الرصيد</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {previousBalance !== 0 && !multiCcy && (
                  <tr className="h-11 bg-muted/40 align-middle [&>td]:px-3 [&>td]:py-2">
                    <td className="tabular-nums text-muted-foreground">—</td>
                    <td className="tabular-nums text-muted-foreground">—</td>
                    <td className="text-xs font-semibold">رصيد سابق</td>
                    <td colSpan={multiCcy ? 8 : 7} className="text-muted-foreground">
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
                      colSpan={colCount}
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
                        if (r.referenceId && isInvoiceStatementRow(r)) {
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
                        {/* #3: real text space + parentheses (matches print
                            "فاتورة بيع (ملغاة)"), not just a CSS margin. */}
                        {r.status === "cancelled" && (
                          <>
                            {" "}
                            <span
                              className="inline-block rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-bold text-destructive"
                              title="قيد ملغى — لا يُحسب في المجاميع أو الرصيد"
                            >
                              (ملغاة)
                            </span>
                          </>
                        )}
                      </td>
                      <td
                        className={`tabular-nums text-primary ${
                          r.status === "cancelled" ? "text-destructive/50 line-through" : ""
                        }`}
                      >
                        {r.referenceNumber}
                      </td>
                      <td>
                        {isInvoiceStatementRow(r) && r.referenceId ? (
                          <StatementInvoiceActions
                            invoiceId={r.referenceId}
                            invoice={invoicesById.get(r.referenceId)}
                            onDelete={setToDelete}
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="text-muted-foreground">
                        {r.description}
                        {(() => {
                          const note = statementPaymentNote(
                            r.document,
                            r.currency ?? "SYP",
                            r.debit || r.credit,
                          );
                          return note ? (
                            <span className="mt-0.5 block text-[10px] leading-snug text-primary/80">
                              {note}
                            </span>
                          ) : null;
                        })()}
                      </td>
                      {multiCcy && (
                        <td className="tabular-nums text-xs text-muted-foreground">
                          {currencySymbol((r.currency as Currency) ?? "SYP")}
                        </td>
                      )}
                      <td
                        className={`text-left tabular-nums ${
                          r.status === "cancelled" ? "text-destructive/50 line-through" : ""
                        }`}
                        data-testid="stmt-original-amount"
                      >
                        {statementOriginalAmount(r.document) ?? "—"}
                      </td>
                      <td
                        className={`text-left tabular-nums text-muted-foreground ${
                          r.status === "cancelled" ? "text-destructive/50 line-through" : ""
                        }`}
                        data-testid="stmt-rate"
                        title={
                          r.document?.kind === "invoice"
                            ? "سعر الصرف التاريخي المثبّت على الفاتورة"
                            : "سعر الصرف وقت الدفع"
                        }
                      >
                        {statementRateToShow(r.document) != null
                          ? fmt(statementRateToShow(r.document) as number)
                          : "—"}
                      </td>
                      <td
                        className={`text-left tabular-nums ${
                          r.status === "cancelled" ? "text-destructive/50 line-through" : ""
                        }`}
                      >
                        {r.quantityKg ? `${fmt(r.quantityKg)} كجم` : "—"}
                      </td>
                      <td
                        className={`text-left tabular-nums ${
                          r.status === "cancelled" ? "text-destructive/50 line-through" : ""
                        }`}
                      >
                        {r.pricePerKg ? fmt(r.pricePerKg) : "—"}
                      </td>
                      <td
                        className={`text-left tabular-nums ${
                          r.status === "cancelled" ? "text-destructive/50 line-through" : ""
                        }`}
                      >
                        {r.debit ? fmt(r.debit) : "—"}
                      </td>
                      <td
                        className={`text-left tabular-nums ${
                          r.status === "cancelled" ? "text-destructive/50 line-through" : ""
                        }`}
                      >
                        {r.credit ? fmt(r.credit) : "—"}
                      </td>
                      <td
                        className={`text-left font-semibold tabular-nums ${
                          r.status === "cancelled"
                            ? "text-muted-foreground/70"
                            : r.runningBalance > 0
                              ? "text-warning"
                              : r.runningBalance < 0
                                ? "text-success"
                                : ""
                        }`}
                        title={
                          r.status === "cancelled"
                            ? "الرصيد الجاري هنا لم يتأثر بالقيد الملغى (غير محتسب)"
                            : undefined
                        }
                      >
                        <MoneyText
                          amount={r.runningBalance}
                          currency={multiCcy ? ((r.currency as Currency) ?? "SYP") : ""}
                        />
                        {/* #4: make explicit that the cancelled row did NOT move
                            the balance, instead of silently carrying it forward. */}
                        {r.status === "cancelled" && (
                          <span className="mt-0.5 block text-[9px] font-normal text-destructive/70">
                            (لم يُحتسب)
                          </span>
                        )}
                      </td>
                      <td className="text-left">
                        {spendable(r) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleRow(r.id);
                            }}
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
                        <td colSpan={colCount}>
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
                  {footerTotals.map((t) => (
                    <tr key={t.currency || "single"} className="[&>td]:px-3 [&>td]:py-2.5">
                      <td colSpan={colCount - 4} className="text-left">
                        {multiCcy
                          ? `الإجمالي — ${currencySymbol(t.currency as Currency)}`
                          : "الإجمالي"}
                      </td>
                      <td className="text-left tabular-nums">{fmt(t.totalDebit)}</td>
                      <td className="text-left tabular-nums">{fmt(t.totalCredit)}</td>
                      <td
                        className={`text-left tabular-nums ${
                          t.finalBalance > 0
                            ? "text-warning"
                            : t.finalBalance < 0
                              ? "text-success"
                              : ""
                        }`}
                      >
                        {fmt(t.finalBalance)}{" "}
                        {multiCcy ? currencySymbol(t.currency as Currency) : cur}
                      </td>
                      <td />
                    </tr>
                  ))}
                </tfoot>
              )}
            </table>
          </div>
        </PageCard>
      )}

      <SettlementDialog
        open={settleOpen}
        onOpenChange={setSettleOpen}
        partyId={p.id}
        partyName={p.name}
        partyCode={p.code}
        kind={kind}
        outstanding={outstandingForSettle}
      />

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من حذف الفاتورة "{toDelete?.number}"؟ لا يمكن التراجع عن هذا الإجراء.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogAction
              onClick={() => {
                if (toDelete) void cancelInvoice.mutateAsync(toDelete.id);
                setToDelete(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              حذف نهائي
            </AlertDialogAction>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ---------------- Outstanding ---------------- */

function OutstandingTab({ p }: { p: Party }) {
  const { data: invData } = useInvoicesList({ partyId: p.id, limit: 1000 });
  const invs = invData?.data ?? [];
  const { data: vData } = useVouchersList({ partyId: p.id, limit: 1000 });
  const vchs = vData?.data ?? [];
  const { data: returnsData } = useReturnsList({
    partyId: p.id,
    status: "active",
    limit: 1000,
  });
  const rows = buildOutstanding(
    p.id,
    invs,
    vchs,
    undefined,
    (returnsData?.data ?? []).map((r) => ({
      originalInvoiceId: r.originalInvoiceId,
      status: r.status,
      amount: returnAmount(r),
    })),
  );
  const [dueCcy, setDueCcy] = useState<"SYP" | "USD">("SYP");
  const [dueCcyTouched, setDueCcyTouched] = useState(false);
  const sypDue = rows.some((r) => r.currency === "SYP");
  const usdDue = rows.some((r) => r.currency === "USD");
  useEffect(() => {
    if (dueCcyTouched) return;
    if (!sypDue && usdDue) setDueCcy("USD");
  }, [sypDue, usdDue, dueCcyTouched]);
  const ccy = dueCcy;
  const cur = currencySymbol(ccy);
  const ccyRows = rows.filter((r) => r.currency === ccy);
  const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 } as Record<
    "0-30" | "31-60" | "61-90" | "90+",
    number
  >;
  for (const r of ccyRows) {
    buckets[r.bucket] += r.remaining;
  }
  const due = ccyRows.reduce((s, r) => s + r.remaining, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {(["SYP", "USD"] as const).map((code) => {
          const active = dueCcy === code;
          return (
            <Button
              key={code}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              className="h-9 min-w-[7.5rem] gap-1.5"
              aria-pressed={active}
              onClick={() => {
                setDueCcyTouched(true);
                setDueCcy(code);
              }}
            >
              {code === "SYP" ? "ل.س SYP" : "$ USD"}
            </Button>
          );
        })}
      </div>

      {ccyRows.length === 0 ? (
        <PageCard title={`الرصيد المستحق — ${cur}`}>
          <div className="py-10 text-center text-xs text-muted-foreground">
            لا رصيد مستحق بهذه العملة.
          </div>
        </PageCard>
      ) : (
        <>
          <PageCard
            title={`تحليل التقادم — ${cur}`}
            description={`توزيع الرصيد المستحق بعملة ${cur} حسب عمر الفاتورة. الإجمالي المستحق:`}
            tone="primary"
          >
            <div className="mb-3 text-sm font-semibold">
              <MoneyText amount={due} currency={ccy} />
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              {(["0-30", "31-60", "61-90", "90+"] as const).map((b) => (
                <div
                  key={b}
                  className="rounded-lg border border-primary/20 bg-background/60 px-4 py-3"
                >
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
                    <MoneyText amount={buckets[b]} currency={ccy} />
                  </div>
                </div>
              ))}
            </div>
          </PageCard>

          <PageCard
            title={`الفواتير المفتوحة — ${cur}`}
            description={`الفواتير غير المسدّدة بالكامل بعملة ${cur}.`}
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
                  {ccyRows.map((r) => (
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
                      <td className="text-left tabular-nums">
                        <MoneyText amount={r.total} currency={ccy} />
                      </td>
                      <td className="text-left tabular-nums text-muted-foreground">
                        <MoneyText amount={r.paid} currency={ccy} />
                      </td>
                      <td className="text-left font-semibold tabular-nums text-warning">
                        <MoneyText amount={r.remaining} currency={ccy} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PageCard>
        </>
      )}
    </div>
  );
}

/* ---------------- Stats / History ---------------- */

function StatsTab({ p, kind }: { p: Party; kind: PartyKind }) {
  const { data: invData } = useInvoicesList({ partyId: p.id, limit: 1000 });
  const invs = invData?.data ?? [];
  const { data: vData } = useVouchersList({ partyId: p.id, limit: 1000 });
  const vchs = vData?.data ?? [];
  const { data: returnsData } = useReturnsList({
    partyId: p.id,
    status: "active",
    limit: 1000,
  });
  const colorNames = Object.fromEntries(colors.map((c) => [c.id, c.name]));
  const colorCodes = Object.fromEntries(colors.map((c) => [c.id, c.code ?? ""]));
  const fabricNames = Object.fromEntries(fabrics.map((f) => [f.id, f.name]));
  const hist = buildFabricHistory(p.id, kind, invs, colorNames, colorCodes, fabricNames);
  const statsByCurrency = buildPartyStatsByCurrency(
    p,
    kind,
    invs,
    vchs,
    (returnsData?.data ?? []).map((r) => ({
      originalInvoiceId: r.originalInvoiceId,
      status: r.status,
      amount: returnAmount(r),
    })),
  );
  const currencyKeys = Object.keys(statsByCurrency).sort((a, b) => a.localeCompare(b));
  const primaryCcy = (p.currency ?? currencyKeys[0] ?? "SYP") as Currency;
  const stats = statsByCurrency[primaryCcy] ?? {
    invoicesCount: 0,
    totalAmount: 0,
    totalPaid: 0,
    remaining: 0,
    avgInvoice: 0,
    totalKg: 0,
  };
  const topRows = [...hist].sort((a, b) => b.totalKg - a.totalKg);
  const topFabric = topRows[0]?.fabricName;
  const topColor = topRows[0]?.colorName;
  const topDye = topRows[0]?.dyeBatch;
  const isSup = kind === "supplier";

  return (
    <div className="space-y-4">
      {currencyKeys.length > 0 && (
        <PageCard
          title="الرصيد حسب العملة"
          description="لكل عملة على حدة — لا يُخلط السوري بالدولار."
          tone="primary"
        >
          <div className="grid gap-3 md:grid-cols-3">
            {currencyKeys.map((c) => {
              const s = statsByCurrency[c]!;
              const sym = currencySymbol(c as Currency);
              return (
                <div
                  key={c}
                  className="rounded-lg border border-primary/20 bg-background/60 px-4 py-3"
                >
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    مستحق {sym}
                  </div>
                  <div
                    className={`mt-1 text-lg font-bold tabular-nums ${
                      s.remaining > 0 ? "text-warning" : s.remaining < 0 ? "text-success" : ""
                    }`}
                  >
                    {fmt(s.remaining)} <span className="text-xs font-normal opacity-70">{sym}</span>
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                    فواتير {s.invoicesCount} · مدفوع {fmt(s.totalPaid)}
                  </div>
                </div>
              );
            })}
          </div>
        </PageCard>
      )}

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
            suffix={currencySymbol(primaryCcy)}
          />
          <Kpi
            label="متوسط قيمة الفاتورة"
            value={fmt(stats.avgInvoice)}
            suffix={currencySymbol(primaryCcy)}
          />
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
  const { data: invData } = useInvoicesList({ partyId: p.id, limit: 1000 });
  const invs = (invData?.data ?? []).filter((i) => i.partyId === p.id && i.status !== "cancelled");
  const { data: vData } = useVouchersList({ partyId: p.id, limit: 1000 });
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
      <div className={`mt-1 text-lg font-bold tabular-nums ${color}`} dir="ltr">
        {suffix && <span className="mr-1 text-xs font-normal opacity-70">{suffix}</span>}
        {value}
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
