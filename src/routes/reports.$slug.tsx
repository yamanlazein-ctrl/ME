import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { DualCurrency } from "@/components/common/DualCurrency";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useReturnsList, returnAmount } from "@/presentation/hooks/useReturns";
import { useExpensesList } from "@/presentation/hooks/useExpenses";
import {
  useManualMovements,
  MANUAL_TYPE_LABEL,
} from "@/presentation/hooks/useCashbox";
import {
  useInventory,
  fabrics,
  colors,
  rolls,
  fabricById,
} from "@/presentation/hooks/useInventory";
import {
  customers,
  suppliers,
  customerById,
  supplierById,
} from "@/presentation/hooks/useParties";
import {
  useLedgerEntries,
  LEDGER_TYPE_LABEL,
} from "@/presentation/hooks/useLedger";
import { formatDateTime } from "@/lib/utils";
import { formatCurrencyBreakdown, groupAmountsByCurrency } from "@/presentation/hooks/useCurrency";
import type { ReturnDTO } from "@/application/ports/IReturnRepository";
import type { Invoice as DomainInvoice } from "@/domain/entities/Invoice";
import type { LedgerEntry as DomainLedgerEntry } from "@/domain/entities/LedgerEntry";
import { invoiceTotal } from "@/core/calculations/invoiceCalc";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


type Search = { range?: "7" | "30" | "90" | "all" };

export const Route = createFileRoute("/reports/$slug")({
  component: ReportDetailPage,
  validateSearch: (s: Record<string, unknown>): Search => ({
    range: (["7", "30", "90", "all"] as const).includes(
      s.range as "7" | "30" | "90" | "all",
    )
      ? (s.range as "7" | "30" | "90" | "all")
      : "30",
  }),
});

const TITLES: Record<string, { title: string; sub: string }> = {
  "net-sales": { title: "تقرير المبيعات", sub: "فواتير البيع خلال الفترة." },
  purchases: { title: "تقرير المشتريات", sub: "فواتير الدخول (المشتريات)." },
  cashbox: { title: "حركة الصندوق", sub: "الحركات النقدية اليدوية." },
  "inventory-value": {
    title: "قيمة المخزون",
    sub: "كل صنف والكمية المتاحة وقيمته.",
  },
  receivables: { title: "ذمم العملاء", sub: "المبالغ المتبقية على العملاء." },
  payables: { title: "ذمم الموردين", sub: "المبالغ المتبقية للموردين." },
  "sales-returns": {
    title: "مرتجعات المبيعات",
    sub: "المرتجعات الصادرة من العملاء.",
  },
  expenses: { title: "المصاريف", sub: "بنود المصاريف خلال الفترة." },
  "top-fabrics": {
    title: "أعلى الأصناف مبيعاً",
    sub: "ترتيب الأصناف حسب الكمية والإيراد.",
  },
  "top-customers": { title: "أعلى العملاء", sub: "ترتيب العملاء حسب الإيراد." },
  ledger: {
    title: "تقرير دفتر الأستاذ",
    sub: "قيود دفتر الحركات المركزي خلال الفترة.",
  },
};

function useCutoff(range: Search["range"]) {
  return useMemo(() => {
    if (range === "all") return null;
    const d = new Date();
    d.setDate(d.getDate() - parseInt(range ?? "30", 10));
    return d.toISOString().slice(0, 10);
  }, [range]);
}

function ReportDetailPage() {
  useInventory();

  // Reports aggregate full datasets — never the paginated (limit=20) default
  // used by the invoices/summaries pages.
  const { data: invoicesData } = useInvoicesList({ limit: 1000, page: 0 });
  const invoicesArr = useMemo(() => invoicesData?.data ?? [], [invoicesData]);
  const { data: vouchersData } = useVouchersList({ limit: 1000 });
  const vouchersArr = useMemo(() => vouchersData?.data ?? [], [vouchersData]);
  const { data: returnsData } = useReturnsList({ limit: 1000 });
  const returnsArr = useMemo(() => returnsData?.data ?? [], [returnsData]);
  const { data: expensesData } = useExpensesList({ limit: 1000 });
  const expensesArr = useMemo(() => expensesData ?? [], [expensesData]);
  const { data: manualMoves = [] } = useManualMovements();
  const { data: ledgerEntriesArr = [] } = useLedgerEntries({ limit: 1000 });

  const { slug } = Route.useParams();
  const search = useSearch({ from: "/reports/$slug" });
  const range = search.range ?? "30";
  const cutoff = useCutoff(range);
  const inRange = (date: string) => (cutoff ? date >= cutoff : true);

  const meta = TITLES[slug] ?? { title: "تقرير", sub: "" };

  return (
    <AppShell title={meta.title} subtitle={meta.sub}>
      <div className="mb-3 flex items-center justify-between">
        <Link
          to="/reports"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <ArrowRight className="h-3.5 w-3.5" /> رجوع إلى التقارير
        </Link>
        <div className="flex gap-1">
          {(["7", "30", "90", "all"] as const).map((r) => (
            <Link
              key={r}
              to="/reports/$slug"
              params={{ slug }}
              search={{ range: r }}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition ${
                range === r
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:border-primary/50"
              }`}
            >
              {r === "all" ? "الكل" : `${r} يوم`}
            </Link>
          ))}
        </div>
      </div>

      <ReportBody
        slug={slug}
        inRange={inRange}
        invoices={invoicesArr}
        returns={returnsArr}
        expenses={expensesArr}
        manualMoves={manualMoves}
        ledgerEntriesArr={ledgerEntriesArr}
        vouchers={vouchersArr}
      />
    </AppShell>
  );
}

function ReportBody({
  slug,
  inRange,
  invoices,
  returns,
  expenses,
  manualMoves,
  ledgerEntriesArr,
  vouchers,
}: {
  slug: string;
  inRange: (d: string) => boolean;
  invoices: DomainInvoice[];
  returns: ReturnDTO[];
  expenses: {
    id: string;
    date: string;
    createdAt?: string;
    amount: number;
    currency: string;
    category: string;
    status: string;
    description: string;
    reference?: string;
  }[];
  manualMoves: {
    id: string;
    date: string;
    type: string;
    direction: "in" | "out";
    amount: number;
    currency: string;
    description: string;
    createdAt: string;
  }[];
  ledgerEntriesArr: DomainLedgerEntry[];
  vouchers: {
    id: string;
    invoiceId?: string | null;
    status: string;
    amount: number;
  }[];
}) {
  switch (slug) {
    case "net-sales":
      return (
        <SalesReport
          inRange={inRange}
          invoices={invoices}
          kind="sale"
          vouchers={vouchers}
        />
      );
    case "purchases":
      return (
        <SalesReport
          inRange={inRange}
          invoices={invoices}
          kind="entry"
          vouchers={vouchers}
        />
      );
    case "receivables":
      return (
        <PartyBalances
          kind="customer"
          invoices={invoices}
          vouchers={vouchers}
        />
      );
    case "payables":
      return (
        <PartyBalances
          kind="supplier"
          invoices={invoices}
          vouchers={vouchers}
        />
      );
    case "sales-returns":
      return <ReturnsReport inRange={inRange} returns={returns} />;
    case "expenses":
      return <ExpensesReport inRange={inRange} expenses={expenses} />;
    case "ledger":
      return <LedgerReport inRange={inRange} entries={ledgerEntriesArr} />;
    case "cashbox":
      return <CashboxReport inRange={inRange} manualMoves={manualMoves} />;
    case "inventory-value":
      return <InventoryReport />;
    case "top-fabrics":
      return <TopFabricsReport inRange={inRange} invoices={invoices} />;
    case "top-customers":
      return <TopCustomersReport inRange={inRange} invoices={invoices} />;
    default:
      return (
        <PageCard title="غير معروف">
          <p className="text-sm text-muted-foreground">
            التقرير المطلوب غير متاح.
          </p>
        </PageCard>
      );
  }
}

function TableWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-right text-sm">{children}</table>
    </div>
  );
}

function TH({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th className={`px-3 py-2 ${align === "left" ? "text-left" : ""}`}>
      {children}
    </th>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="p-6 text-center text-sm text-muted-foreground">{text}</div>
  );
}

function SalesReport({
  inRange,
  invoices,
  kind,
  vouchers,
}: {
  inRange: (d: string) => boolean;
  invoices: DomainInvoice[];
  kind: "sale" | "entry";
  vouchers: {
    id: string;
    invoiceId?: string | null;
    status: string;
    amount: number;
  }[];
}) {
  const rows = invoices
    .filter(
      (i) => i.status !== "cancelled" && i.type === kind && inRange(i.date),
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const paidByInvoice = (invoiceId: string) =>
    vouchers
      .filter((v) => v.status === "active" && v.invoiceId === invoiceId)
      .reduce((s, v) => s + v.amount, 0);
  const totalByCurrency = groupAmountsByCurrency(rows, invoiceTotal, (i) => i.currency);
  const paidByCurrency = groupAmountsByCurrency(rows, (i) => paidByInvoice(i.id), (i) => i.currency);
  const remainingByCurrency = groupAmountsByCurrency(
    rows,
    (i) => Math.max(0, invoiceTotal(i) - paidByInvoice(i.id)),
    (i) => i.currency,
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <StatBox label="عدد الفواتير" value={rows.length.toString()} />
        <StatBox label="الإجمالي" byCurrency={totalByCurrency} />
        <StatBox label="المدفوع" byCurrency={paidByCurrency} tone="good" />
        <StatBox label="المتبقي" byCurrency={remainingByCurrency} tone="warning" />
      </div>
      <PageCard
        title={kind === "sale" ? "قائمة فواتير البيع" : "قائمة فواتير الدخول"}
        noBodyPadding
      >
        {rows.length === 0 ? (
          <Empty text="لا فواتير في الفترة المحددة." />
        ) : (
          <TableWrap>
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr>
                <TH>الرقم</TH>
                <TH>التاريخ</TH>
                <TH>{kind === "sale" ? "العميل" : "المورد"}</TH>
                <TH>الإجمالي</TH>
                <TH>المدفوع</TH>
                <TH>المتبقي</TH>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="px-3 py-2">
                    <Link
                      to="/invoices/$id"
                      params={{ id: i.id }}
                      className="text-primary font-semibold hover:underline"
                    >
                      {i.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatDateTime(i.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    {kind === "sale"
                      ? customerById(i.partyId)?.name
                      : (supplierById(i.partyId)?.name ?? i.partyId)}
                  </td>
                  <td className="px-3 py-2 tabular-nums font-semibold">
                    {formatMoney(invoiceTotal(i))}{" "}
                    {i.currency}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatMoney(paidByInvoice(i.id))}{" "}
                    {i.currency}
                  </td>
                  <td className="px-3 py-2 tabular-nums font-semibold">
                    {formatMoney(
                      Math.max(0, invoiceTotal(i) - paidByInvoice(i.id)),
                    )}{" "}
                    {i.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </PageCard>
    </div>
  );
}

function PartyBalances({
  kind,
  invoices,
  vouchers,
}: {
  kind: "customer" | "supplier";
  invoices: DomainInvoice[];
  vouchers: {
    id: string;
    invoiceId?: string | null;
    status: string;
    amount: number;
  }[];
}) {
  // Fix BUG-06/C-9/C-10: total/paid/remaining are now per-currency
  // breakdowns, never a toSYP-blended single number. Ranking (sort) still
  // needs one comparable figure — SYP remaining specifically, documented,
  // since there is no real FX rate to fairly compare a SYP and a USD
  // party's remaining balance.
  const rows = (kind === "customer" ? customers : suppliers)
    .map((p) => {
      const invs = invoices.filter(
        (i) => i.partyId === p.id && i.status !== "cancelled",
      );
      const total = groupAmountsByCurrency(invs, invoiceTotal, (i) => i.currency);
      const paidOf = (i: DomainInvoice) =>
        vouchers
          .filter((v) => v.status === "active" && v.invoiceId === i.id)
          .reduce((sum, v) => sum + v.amount, 0);
      const paid = groupAmountsByCurrency(invs, paidOf, (i) => i.currency);
      const remaining = groupAmountsByCurrency(
        invs,
        (i) => Math.max(0, invoiceTotal(i) - paidOf(i)),
        (i) => i.currency,
      );
      return { p, total, paid, remaining, count: invs.length };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => (b.remaining.SYP ?? 0) - (a.remaining.SYP ?? 0));

  return (
    <PageCard
      title={kind === "customer" ? "ذمم العملاء" : "ذمم الموردين"}
      noBodyPadding
    >
      {rows.length === 0 ? (
        <Empty text="لا بيانات." />
      ) : (
        <TableWrap>
          <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
            <tr>
              <TH>{kind === "customer" ? "العميل" : "المورد"}</TH>
              <TH>عدد الفواتير</TH>
              <TH>الإجمالي</TH>
              <TH>المدفوع</TH>
              <TH>المتبقي</TH>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.p.id}>
                <td className="px-3 py-2 font-semibold">{r.p.name}</td>
                <td className="px-3 py-2 tabular-nums">{r.count}</td>
                <td className="px-3 py-2 tabular-nums">
                  {formatCurrencyBreakdown(r.total)}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {formatCurrencyBreakdown(r.paid)}
                </td>
                <td className="px-3 py-2 tabular-nums font-semibold">
                  {formatCurrencyBreakdown(r.remaining)}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </PageCard>
  );
}

function ReturnsReport({
  inRange,
  returns,
}: {
  inRange: (d: string) => boolean;
  returns: ReturnDTO[];
}) {
  const rows = returns
    .filter((r) => r.status !== "cancelled" && inRange(r.date))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const totalByCurrency = groupAmountsByCurrency(
    rows,
    (r) => r.lines.reduce((sum, l) => sum + l.quantityKg * l.pricePerKg, 0),
    (r) => r.currency || "SYP",
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <StatBox label="عدد المرتجعات" value={rows.length.toString()} />
        <StatBox label="الإجمالي" byCurrency={totalByCurrency} />
      </div>
      <PageCard title="قائمة المرتجعات" noBodyPadding>
        {rows.length === 0 ? (
          <Empty text="لا مرتجعات في الفترة المحددة." />
        ) : (
          <TableWrap>
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr>
                <TH>الرقم</TH>
                <TH>النوع</TH>
                <TH>التاريخ</TH>
                <TH>الطرف</TH>
                <TH>المبلغ</TH>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-semibold">{r.number}</td>
                  <td className="px-3 py-2">
                    {r.kind === "sale" ? "بيع" : "دخول"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatDateTime(r.createdAt)}
                  </td>
                  <td className="px-3 py-2">{r.partyId}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatMoney(
                      r.lines.reduce(
                        (sum, l) => sum + l.quantityKg * l.pricePerKg,
                        0,
                      ),
                    )}{" "}
                    {r.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </PageCard>
    </div>
  );
}

function ExpensesReport({
  inRange,
  expenses,
}: {
  inRange: (d: string) => boolean;
  expenses: {
    id: string;
    date: string;
    createdAt?: string;
    amount: number;
    currency: string;
    category: string;
    status: string;
    description: string;
    reference?: string;
  }[];
}) {
  const rows = expenses
    .filter((e) => e.status !== "cancelled" && inRange(e.date))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const totalByCurrency = groupAmountsByCurrency(rows, (e) => e.amount, (e) => e.currency);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <StatBox label="عدد المصاريف" value={rows.length.toString()} />
        <StatBox label="الإجمالي" byCurrency={totalByCurrency} />
      </div>
      <PageCard title="قائمة المصاريف" noBodyPadding>
        {rows.length === 0 ? (
          <Empty text="لا مصاريف في الفترة المحددة." />
        ) : (
          <TableWrap>
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr>
                <TH>التاريخ</TH>
                <TH>الفئة</TH>
                <TH>الوصف</TH>
                <TH>المبلغ</TH>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2 tabular-nums">
                    {formatDateTime(e.createdAt)}
                  </td>
                  <td className="px-3 py-2">{e.category}</td>
                  <td className="px-3 py-2">{e.description}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatMoney(e.amount)} {e.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </PageCard>
    </div>
  );
}

function LedgerReport({
  inRange,
  entries,
}: {
  inRange: (d: string) => boolean;
  entries: DomainLedgerEntry[];
}) {
  const rows = (entries ?? [])
    .filter((e) => e.status !== "cancelled" && inRange(e.date))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  // Fix BUG-06/C-9/C-10: these used to sum e.debit/e.credit with no
  // currency grouping at all — a USD ledger row and a SYP row were added
  // directly. Group by e.currency instead.
  const totalDebitByCurrency = groupAmountsByCurrency(rows, (e) => e.debit || 0, (e) => e.currency);
  const totalCreditByCurrency = groupAmountsByCurrency(rows, (e) => e.credit || 0, (e) => e.currency);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <StatBox label="عدد الحركات" value={rows.length.toString()} />
        <StatBox label="إجمالي المدين" byCurrency={totalDebitByCurrency} tone="warning" />
        <StatBox label="إجمالي الدائن" byCurrency={totalCreditByCurrency} tone="warning" />
      </div>
      <PageCard title="قيود دفتر الحركات" noBodyPadding>
        {rows.length === 0 ? (
          <Empty text="لا حركات في الفترة المحددة." />
        ) : (
          <TableWrap>
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr>
                <TH>التاريخ</TH>
                <TH>النوع</TH>
                <TH>الوصف</TH>
                <TH>المرجع</TH>
                <TH>مدين</TH>
                <TH>دائن</TH>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2 tabular-nums">
                    {formatDateTime(e.date)}
                  </td>
                  <td className="px-3 py-2">
                    {LEDGER_TYPE_LABEL[e.type] ?? e.type}
                  </td>
                  <td className="px-3 py-2">{e.description}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {e.referenceNumber ?? "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {e.debit
                      ? `${formatMoney(e.debit)} ${e.currency}`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {e.credit
                      ? `${formatMoney(e.credit)} ${e.currency}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </PageCard>
    </div>
  );
}

function CashboxReport({
  inRange,
  manualMoves,
}: {
  inRange: (d: string) => boolean;
  manualMoves: {
    id: string;
    date: string;
    type: string;
    direction: "in" | "out";
    amount: number;
    currency: string;
    description: string;
    createdAt: string;
  }[];
}) {
  const rows = manualMoves
    .filter((m) => inRange(m.date))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return (
    <PageCard title="حركة الصندوق اليدوية" noBodyPadding>
      {rows.length === 0 ? (
        <Empty text="لا حركات في الفترة المحددة." />
      ) : (
        <TableWrap>
          <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
            <tr>
              <TH>التاريخ</TH>
              <TH>النوع</TH>
              <TH>اتجاه</TH>
              <TH>الوصف</TH>
              <TH>المبلغ</TH>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-2 tabular-nums">
                  {formatDateTime(m.createdAt)}
                </td>
                <td className="px-3 py-2">
                  {MANUAL_TYPE_LABEL[m.type as keyof typeof MANUAL_TYPE_LABEL]}
                </td>
                <td className="px-3 py-2">
                  {m.direction === "in" ? "وارد" : "صادر"}
                </td>
                <td className="px-3 py-2">{m.description}</td>
                <td className="px-3 py-2 tabular-nums font-semibold">
                  {formatMoney(m.amount)} {m.currency}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </PageCard>
  );
}

function InventoryReport() {
  // Fix BUG-06/C-9/C-10: `val` used to convert every roll's value through
  // toSYP and sum it into one blended number, both per-fabric and in the
  // grand total. Group by currency at both levels instead.
  const rows = fabrics.map((f) => {
    const fColors = colors.filter((c) => c.fabricId === f.id);
    const fRolls = rolls.filter((r) => fColors.some((c) => c.id === r.colorId));
    const kg = fRolls.reduce((s, r) => s + r.remainingKg, 0);
    const valByCurrency = groupAmountsByCurrency(
      fRolls,
      (r) => r.remainingKg * r.pricePerKg,
      (r) => r.currency,
    );
    return { f, kg, valByCurrency, rolls: fRolls.length };
  });
  const totalValByCurrency: Record<string, number> = {};
  for (const r of rows) {
    for (const [cur, amt] of Object.entries(r.valByCurrency)) {
      totalValByCurrency[cur] = (totalValByCurrency[cur] ?? 0) + amt;
    }
  }
  return (
    <div className="space-y-3">
      <StatBox label="القيمة الإجمالية" byCurrency={totalValByCurrency} />
      <PageCard title="المخزون حسب الصنف" noBodyPadding>
        {rows.length === 0 ? (
          <Empty text="لا مخزون." />
        ) : (
          <TableWrap>
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr>
                <TH>الصنف</TH>
                <TH>الكمية</TH>
                <TH>عدد الصبغات</TH>
                <TH>القيمة</TH>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.f.id}>
                  <td className="px-3 py-2 font-semibold">{r.f.name}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatNumber(r.kg)} كغ
                  </td>
                  <td className="px-3 py-2 tabular-nums">{r.rolls}</td>
                  <td className="px-3 py-2 tabular-nums font-semibold">
                    {formatCurrencyBreakdown(r.valByCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </PageCard>
    </div>
  );
}

function TopFabricsReport({
  inRange,
  invoices,
}: {
  inRange: (d: string) => boolean;
  invoices: DomainInvoice[];
}) {
  const invs = invoices.filter(
    (i) => i.type === "sale" && i.status !== "cancelled" && inRange(i.date),
  );
  // Fix BUG-06/C-9/C-10: revenue is now a per-currency breakdown, never a
  // toSYP-blended single number. Ranked by kg sold (currency-agnostic,
  // safe to sum) rather than a converted revenue figure.
  const map = new Map<string, { qty: number; revenueByCurrency: Record<string, number> }>();
  invs.forEach((i) =>
    i.lines.forEach((l) => {
      const c = map.get(l.fabricId) ?? { qty: 0, revenueByCurrency: {} };
      c.qty += l.quantityKg;
      c.revenueByCurrency[i.currency] = (c.revenueByCurrency[i.currency] ?? 0) + l.quantityKg * l.pricePerKg;
      map.set(l.fabricId, c);
    }),
  );
  const rows = [...map.entries()]
    .map(([id, v]) => ({ fabric: fabricById(id), ...v }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);
  return (
    <PageCard title="أعلى ١٠ أصناف مبيعاً" noBodyPadding>
      {rows.length === 0 ? (
        <Empty text="لا مبيعات في الفترة." />
      ) : (
        <TableWrap>
          <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
            <tr>
              <TH>الصنف</TH>
              <TH>الكمية</TH>
              <TH>الإيراد</TH>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-2 font-semibold">
                  {r.fabric?.name ?? ""}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {formatMoney(r.qty)} كغ
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {formatCurrencyBreakdown(r.revenueByCurrency)}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </PageCard>
  );
}

function TopCustomersReport({
  inRange,
  invoices,
}: {
  inRange: (d: string) => boolean;
  invoices: DomainInvoice[];
}) {
  const invs = invoices.filter(
    (i) => i.type === "sale" && i.status !== "cancelled" && inRange(i.date),
  );
  // Fix BUG-06/C-9/C-10: revenue is now a per-currency breakdown, never a
  // toSYP-blended single number. Ranked by SYP revenue (documented, not
  // blended) since a single sortable figure is needed.
  const map = new Map<string, Record<string, number>>();
  invs.forEach((i) => {
    const prev = map.get(i.partyId) ?? {};
    prev[i.currency] = (prev[i.currency] ?? 0) + invoiceTotal(i);
    map.set(i.partyId, prev);
  });
  const rows = [...map.entries()]
    .map(([id, revenueByCurrency]) => ({ cust: customerById(id), revenueByCurrency }))
    .sort((a, b) => (b.revenueByCurrency.SYP ?? 0) - (a.revenueByCurrency.SYP ?? 0))
    .slice(0, 10);
  return (
    <PageCard title="أعلى ١٠ عملاء" noBodyPadding>
      {rows.length === 0 ? (
        <Empty text="لا مبيعات في الفترة." />
      ) : (
        <TableWrap>
          <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
            <tr>
              <TH>العميل</TH>
              <TH>الإيراد</TH>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-2 font-semibold">
                  {r.cust?.name ?? ""}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {formatCurrencyBreakdown(r.revenueByCurrency)}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </PageCard>
  );
}

function StatBox({
  label,
  value,
  syp,
  byCurrency,
  tone,
}: {
  label: string;
  value?: string;
  /** Single-currency figure (unchanged usage — genuinely SYP-only sources). */
  syp?: number;
  /**
   * Fix BUG-06/C-9/C-10 (forensic audit 2026-08-15): when the underlying
   * figure can span multiple currencies, pass a breakdown instead of a
   * toSYP-blended `syp` number — renders each currency's own amount via
   * formatCurrencyBreakdown, never a converted/summed total.
   */
  byCurrency?: Record<string, number>;
  tone?: string;
}) {
  const bg =
    tone === "warning"
      ? "bg-yellow-500/10 border-yellow-500/40"
      : "bg-card border-border";
  return (
    <div className={`rounded-lg border ${bg} p-4`}>
      <div className="text-[11px] font-semibold text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-bold tabular-nums">
        {value ??
          (byCurrency
            ? formatCurrencyBreakdown(byCurrency)
            : syp != null
              ? formatMoney(syp)
              : "0")}
        {syp != null && !byCurrency && (
          <DualCurrency syp={syp} className="text-[10px] mt-0.5" />
        )}
      </div>
    </div>
  );
}
