import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { DualCurrency } from "@/components/common/DualCurrency";
import { MANUAL_TYPE_LABEL } from "@/presentation/hooks/useCashbox";
import { LEDGER_TYPE_LABEL } from "@/presentation/hooks/useLedger";
import { useReportDetail, type ByCurrency } from "@/presentation/hooks/useReports";
import { container } from "@/infrastructure/container";
import { formatDateTime } from "@/lib/utils";
import { formatCurrencyBreakdown } from "@/presentation/hooks/useCurrency";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";

import { localDateISO } from "@/lib/localDate";
type Search = { range?: "7" | "30" | "90" | "all" };

export const Route = createFileRoute("/reports/$slug")({
  component: ReportDetailPage,
  validateSearch: (s: Record<string, unknown>): Search => ({
    range: (["7", "30", "90", "all"] as const).includes(s.range as "7" | "30" | "90" | "all")
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
    return localDateISO(d);
  }, [range]);
}

function ReportDetailPage() {
  const { slug } = Route.useParams();
  const search = useSearch({ from: "/reports/$slug" });
  const range = search.range ?? "30";
  const cutoff = useCutoff(range);

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

      <ReportBody key={`${slug}:${cutoff ?? "all"}`} slug={slug} from={cutoff} />
    </AppShell>
  );
}

/**
 * Reports are computed on the SERVER (SQL aggregates + paged rows). The page
 * never downloads the full invoice/voucher/ledger history: summary figures
 * cover the whole period, the table shows one page at a time.
 */
function ReportBody({ slug, from }: { slug: string; from: string | null }) {
  switch (slug) {
    case "net-sales":
      return <SalesReport from={from} kind="sale" />;
    case "purchases":
      return <SalesReport from={from} kind="entry" />;
    case "receivables":
      return <PartyBalances kind="customer" />;
    case "payables":
      return <PartyBalances kind="supplier" />;
    case "sales-returns":
      return <ReturnsReport from={from} />;
    case "expenses":
      return <ExpensesReport from={from} />;
    case "ledger":
      return <LedgerReport from={from} />;
    case "cashbox":
      return <CashboxReport from={from} />;
    case "inventory-value":
      return <InventoryReport />;
    case "top-fabrics":
      return <TopFabricsReport from={from} />;
    case "top-customers":
      return <TopCustomersReport from={from} />;
    default:
      return (
        <PageCard title="غير معروف">
          <p className="text-sm text-muted-foreground">التقرير المطلوب غير متاح.</p>
        </PageCard>
      );
  }
}

const PAGE_SIZE = 100;

function usePagedReport<R>(slug: string, from: string | null) {
  const [page, setPage] = useState(0);
  const q = useReportDetail<R>(slug, from, page, PAGE_SIZE);
  return { page, setPage, ...q };
}

function Pager({
  page,
  setPage,
  meta,
  loading,
}: {
  page: number;
  setPage: (p: number) => void;
  meta?: { total: number; hasNext: boolean };
  loading?: boolean;
}) {
  if (!meta || meta.total <= PAGE_SIZE) return null;
  const pages = Math.max(1, Math.ceil(meta.total / PAGE_SIZE));
  return (
    <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
      <span>
        صفحة {page + 1} من {pages} — {meta.total} سجل
        {loading ? " — جاري التحميل…" : ""}
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          السابق
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!meta.hasNext}
          onClick={() => setPage(page + 1)}
        >
          التالي
        </Button>
      </div>
    </div>
  );
}

const asBy = (v: unknown): ByCurrency => (v && typeof v === "object" ? (v as ByCurrency) : {});

type SalesRow = {
  id: string;
  number: string;
  createdAt: string;
  currency: string;
  partyId: string;
  partyName: string | null;
  total: number;
  paid: number;
  remaining: number;
};

function SalesReport({ from, kind }: { from: string | null; kind: "sale" | "entry" }) {
  const { page, setPage, data, isFetching } = usePagedReport<SalesRow>(
    kind === "sale" ? "net-sales" : "purchases",
    from,
  );
  const rows = data?.rows ?? [];
  const sum = data?.summary ?? {};
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <StatBox label="عدد الفواتير" value={String(sum.count ?? 0)} />
        <StatBox label="الإجمالي" byCurrency={asBy(sum.total)} />
        <StatBox label="المدفوع" byCurrency={asBy(sum.paid)} tone="good" />
        <StatBox label="المتبقي" byCurrency={asBy(sum.remaining)} tone="warning" />
      </div>
      <PageCard
        title={kind === "sale" ? "قائمة فواتير البيع" : "قائمة فواتير الدخول"}
        noBodyPadding
      >
        {rows.length === 0 ? (
          <Empty text={isFetching ? "جاري التحميل…" : "لا فواتير في الفترة المحددة."} />
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
                  <td className="px-3 py-2 tabular-nums">{formatDateTime(i.createdAt)}</td>
                  <td className="px-3 py-2">{i.partyName ?? i.partyId}</td>
                  <td className="px-3 py-2 tabular-nums font-semibold">
                    {formatMoney(i.total)} {i.currency}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatMoney(i.paid)} {i.currency}
                  </td>
                  <td className="px-3 py-2 tabular-nums font-semibold">
                    {formatMoney(i.remaining)} {i.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        <Pager page={page} setPage={setPage} meta={data?.meta} loading={isFetching} />
      </PageCard>
    </div>
  );
}

type ReturnRow = {
  id: string;
  number: string;
  kind: string;
  createdAt: string;
  currency: string;
  partyId: string;
  partyName: string | null;
  amount: number;
};

function ReturnsReport({ from }: { from: string | null }) {
  const { page, setPage, data, isFetching } = usePagedReport<ReturnRow>("sales-returns", from);
  const rows = data?.rows ?? [];
  const sum = data?.summary ?? {};
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <StatBox label="عدد المرتجعات" value={String(sum.count ?? 0)} />
        <StatBox label="الإجمالي" byCurrency={asBy(sum.total)} />
      </div>
      <PageCard title="قائمة المرتجعات" noBodyPadding>
        {rows.length === 0 ? (
          <Empty text={isFetching ? "جاري التحميل…" : "لا مرتجعات في الفترة المحددة."} />
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
                  <td className="px-3 py-2">{r.kind === "sale" ? "بيع" : "دخول"}</td>
                  <td className="px-3 py-2 tabular-nums">{formatDateTime(r.createdAt)}</td>
                  <td className="px-3 py-2">{r.partyName ?? r.partyId}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatMoney(r.amount)} {r.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        <Pager page={page} setPage={setPage} meta={data?.meta} loading={isFetching} />
      </PageCard>
    </div>
  );
}

type ExpenseRow = {
  id: string;
  createdAt: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
};

function ExpensesReport({ from }: { from: string | null }) {
  const { page, setPage, data, isFetching } = usePagedReport<ExpenseRow>("expenses", from);
  const rows = data?.rows ?? [];
  const sum = data?.summary ?? {};
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <StatBox label="عدد المصاريف" value={String(sum.count ?? 0)} />
        <StatBox label="الإجمالي" byCurrency={asBy(sum.total)} />
      </div>
      <PageCard title="قائمة المصاريف" noBodyPadding>
        {rows.length === 0 ? (
          <Empty text={isFetching ? "جاري التحميل…" : "لا مصاريف في الفترة المحددة."} />
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
                  <td className="px-3 py-2 tabular-nums">{formatDateTime(e.createdAt)}</td>
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
        <Pager page={page} setPage={setPage} meta={data?.meta} loading={isFetching} />
      </PageCard>
    </div>
  );
}

type LedgerRow = {
  id: string;
  date: string;
  type: string;
  description: string;
  referenceNumber: string | null;
  debit: number;
  credit: number;
  currency: string;
};

function LedgerReport({ from }: { from: string | null }) {
  const { page, setPage, data, isFetching } = usePagedReport<LedgerRow>("ledger", from);
  const rows = data?.rows ?? [];
  const sum = data?.summary ?? {};
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <StatBox label="عدد الحركات" value={String(sum.count ?? 0)} />
        <StatBox label="إجمالي المدين" byCurrency={asBy(sum.debit)} tone="warning" />
        <StatBox label="إجمالي الدائن" byCurrency={asBy(sum.credit)} tone="warning" />
      </div>
      <PageCard title="قيود دفتر الحركات" noBodyPadding>
        {rows.length === 0 ? (
          <Empty text={isFetching ? "جاري التحميل…" : "لا حركات في الفترة المحددة."} />
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
                  <td className="px-3 py-2 tabular-nums">{formatDateTime(e.date)}</td>
                  <td className="px-3 py-2">
                    {LEDGER_TYPE_LABEL[e.type as keyof typeof LEDGER_TYPE_LABEL] ?? e.type}
                  </td>
                  <td className="px-3 py-2">{e.description}</td>
                  <td className="px-3 py-2 tabular-nums">{e.referenceNumber ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {e.debit ? `${formatMoney(e.debit)} ${e.currency}` : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {e.credit ? `${formatMoney(e.credit)} ${e.currency}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
        <Pager page={page} setPage={setPage} meta={data?.meta} loading={isFetching} />
      </PageCard>
    </div>
  );
}

type CashRow = {
  id: string;
  createdAt: string;
  type: string;
  direction: "in" | "out";
  description: string;
  amount: number;
  currency: string;
};

function CashboxReport({ from }: { from: string | null }) {
  const { page, setPage, data, isFetching } = usePagedReport<CashRow>("cashbox", from);
  const rows = data?.rows ?? [];
  return (
    <PageCard title="حركة الصندوق اليدوية" noBodyPadding>
      {rows.length === 0 ? (
        <Empty text={isFetching ? "جاري التحميل…" : "لا حركات في الفترة المحددة."} />
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
                <td className="px-3 py-2 tabular-nums">{formatDateTime(m.createdAt)}</td>
                <td className="px-3 py-2">
                  {MANUAL_TYPE_LABEL[m.type as keyof typeof MANUAL_TYPE_LABEL]}
                </td>
                <td className="px-3 py-2">{m.direction === "in" ? "وارد" : "صادر"}</td>
                <td className="px-3 py-2">{m.description}</td>
                <td className="px-3 py-2 tabular-nums font-semibold">
                  {formatMoney(m.amount)} {m.currency}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <Pager page={page} setPage={setPage} meta={data?.meta} loading={isFetching} />
    </PageCard>
  );
}

type FabricValueRow = {
  fabricId: string;
  name: string;
  kg: number;
  rolls: number;
  value: ByCurrency;
};

function InventoryReport() {
  const { data, isFetching } = useReportDetail<FabricValueRow>("inventory-value", null, 0);
  const rows = data?.rows ?? [];
  return (
    <div className="space-y-3">
      <StatBox label="القيمة الإجمالية" byCurrency={asBy(data?.summary?.total)} />
      <PageCard title="المخزون حسب الصنف" noBodyPadding>
        {rows.length === 0 ? (
          <Empty text={isFetching ? "جاري التحميل…" : "لا مخزون."} />
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
                <tr key={r.fabricId}>
                  <td className="px-3 py-2 font-semibold">{r.name}</td>
                  <td className="px-3 py-2 tabular-nums">{formatNumber(r.kg)} كغ</td>
                  <td className="px-3 py-2 tabular-nums">{r.rolls}</td>
                  <td className="px-3 py-2 tabular-nums font-semibold">
                    {formatCurrencyBreakdown(r.value)}
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

type TopFabricRow = {
  fabricId: string;
  name: string;
  qty: number;
  revenueByCurrency: ByCurrency;
};

function TopFabricsReport({ from }: { from: string | null }) {
  const { data, isFetching } = useReportDetail<TopFabricRow>("top-fabrics", from, 0);
  const rows = data?.rows ?? [];
  return (
    <PageCard title="أعلى ١٠ أصناف مبيعاً" noBodyPadding>
      {rows.length === 0 ? (
        <Empty text={isFetching ? "جاري التحميل…" : "لا مبيعات في الفترة."} />
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
            {rows.map((r) => (
              <tr key={r.fabricId}>
                <td className="px-3 py-2 font-semibold">{r.name}</td>
                <td className="px-3 py-2 tabular-nums">{formatMoney(r.qty)} كغ</td>
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

type TopCustomerRow = { partyId: string; name: string; revenueByCurrency: ByCurrency };

function TopCustomersReport({ from }: { from: string | null }) {
  const { data, isFetching } = useReportDetail<TopCustomerRow>("top-customers", from, 0);
  const rows = data?.rows ?? [];
  return (
    <PageCard title="أعلى ١٠ عملاء" noBodyPadding>
      {rows.length === 0 ? (
        <Empty text={isFetching ? "جاري التحميل…" : "لا مبيعات في الفترة."} />
      ) : (
        <TableWrap>
          <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
            <tr>
              <TH>العميل</TH>
              <TH>الإيراد</TH>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.partyId}>
                <td className="px-3 py-2 font-semibold">{r.name}</td>
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

function TableWrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-right text-sm">{children}</table>
    </div>
  );
}

function TH({ children, align }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <th className={`px-3 py-2 ${align === "left" ? "text-left" : ""}`}>{children}</th>;
}

function Empty({ text }: { text: string }) {
  return <div className="p-6 text-center text-sm text-muted-foreground">{text}</div>;
}

function PartyBalances({ kind }: { kind: "customer" | "supplier" }) {
  // REPAIR-002: server ledger aggregation — never a 1,000-row client slice.
  const [rows, setRows] = useState<
    Array<{
      partyId: string;
      name: string;
      remaining: Record<string, number>;
      total: Record<string, number>;
      paid: Record<string, number>;
      count: number;
    }>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void container.http
      .get<{
        data: Array<{
          partyId: string;
          name: string;
          currency: string | null;
          remaining: string | number;
          total: string | number;
          paid: string | number;
        }>;
      }>(`/api/reports/party-balances?kind=${kind}`)
      .then((res) => {
        if (cancelled) return;
        const byParty = new Map<
          string,
          {
            partyId: string;
            name: string;
            remaining: Record<string, number>;
            total: Record<string, number>;
            paid: Record<string, number>;
            count: number;
          }
        >();
        for (const r of res.data.data ?? []) {
          const id = r.partyId;
          const cur = byParty.get(id) ?? {
            partyId: id,
            name: r.name,
            remaining: {},
            total: {},
            paid: {},
            count: 0,
          };
          const ccy = r.currency ?? "SYP";
          cur.remaining[ccy] = Number(r.remaining ?? 0);
          cur.total[ccy] = Number(r.total ?? 0);
          cur.paid[ccy] = Number(r.paid ?? 0);
          cur.count += 1;
          byParty.set(id, cur);
        }
        setRows(
          [...byParty.values()]
            .filter(
              (r) =>
                Object.values(r.remaining).some((v) => v !== 0) ||
                Object.values(r.total).some((v) => v !== 0),
            )
            .sort((a, b) => (b.remaining.SYP ?? 0) - (a.remaining.SYP ?? 0)),
        );
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  return (
    <PageCard title={kind === "customer" ? "ذمم العملاء" : "ذمم الموردين"} noBodyPadding>
      {loading ? (
        <Empty text="جاري التحميل…" />
      ) : rows.length === 0 ? (
        <Empty text="لا بيانات." />
      ) : (
        <TableWrap>
          <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
            <tr>
              <TH>{kind === "customer" ? "العميل" : "المورد"}</TH>
              <TH>عملات</TH>
              <TH>الإجمالي</TH>
              <TH>المدفوع</TH>
              <TH>المتبقي</TH>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.partyId}>
                <td className="px-3 py-2 font-semibold">{r.name}</td>
                <td className="px-3 py-2 tabular-nums">{Object.keys(r.remaining).join(", ")}</td>
                <td className="px-3 py-2 tabular-nums">{formatCurrencyBreakdown(r.total)}</td>
                <td className="px-3 py-2 tabular-nums">{formatCurrencyBreakdown(r.paid)}</td>
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
  const bg = tone === "warning" ? "bg-yellow-500/10 border-yellow-500/40" : "bg-card border-border";
  return (
    <div className={`rounded-lg border ${bg} p-4`}>
      <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums">
        {value ??
          (byCurrency ? formatCurrencyBreakdown(byCurrency) : syp != null ? formatMoney(syp) : "0")}
        {syp != null && !byCurrency && <DualCurrency syp={syp} className="text-[10px] mt-0.5" />}
      </div>
    </div>
  );
}
