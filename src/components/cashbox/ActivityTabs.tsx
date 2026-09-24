import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLedgerEntries, LEDGER_TYPE_LABEL } from "@/presentation/hooks/useLedger";
import { MANUAL_TYPE_LABEL } from "@/presentation/hooks/useCashbox";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { useHydrated } from "@/hooks/use-hydrated";
import type { LedgerEntry } from "@/core/calculations/ledgerCalc";
import type { ManualMovementDTO } from "@/application/ports/ICashboxRepository";
import type { CashboxPeriodFilter } from "./PeriodFilterCard";
import type { ProfitQueryParams } from "@/contracts/profit";
import { SalesInvoicesTable } from "./SalesInvoicesSection";
import { VoucherTable } from "./VoucherTable";

const INVOICE_LEDGER_TYPES = new Set([
  "sales_invoice",
  "purchase_invoice",
  "sales_return",
  "purchase_return",
]);

/**
 * MAIN ACTIVITY — one visible table behind four tabs.
 * Tab selection lives in the URL so it survives going to an invoice and back.
 * The transactions tab is the SINGLE source for cash movements (period scope
 * includes today via presets — no duplicated "today table").
 */
export function ActivityTabs({
  query,
  period,
  tab,
  onTabChange,
  manualMoves,
  onDeleteManual,
}: {
  query: ProfitQueryParams;
  period: CashboxPeriodFilter;
  tab: string;
  onTabChange: (tab: string) => void;
  manualMoves: ManualMovementDTO[];
  onDeleteManual: (id: string) => void;
}) {
  const hydrated = useHydrated();
  const {
    data: ledgerResult,
    isLoading,
    isError,
    refetch,
    error,
  } = useLedgerEntries(
    {
    fromDate: query.fromDate,
    toDate: query.toDate,
  },
    { all: true },
  );

  useEffect(() => {
    if (error) console.error("[cashbox] ledger feed failed:", error);
  }, [error]);

  const inPeriod = (date: string) =>
    (!period.from || date >= period.from) && (!period.to || date <= period.to);

  const ledgerRows = (ledgerResult ?? []).filter(
    (e) =>
      e.cashImpact !== "none" &&
      (period.currency === "all" || e.currency === period.currency) &&
      inPeriod(e.date),
  );

  const manualRows = manualMoves.filter(
    (m) => (period.currency === "all" || m.currency === period.currency) && inPeriod(m.date),
  );

  const rows = [
    ...ledgerRows.map((e) => ({ kind: "ledger" as const, at: e.createdAt, entry: e })),
    ...manualRows.map((m) => ({ kind: "manual" as const, at: m.createdAt, move: m })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <div className="rounded-xl border border-border bg-card">
      <Tabs value={tab} onValueChange={onTabChange}>
        <div className="border-b border-border px-3 pt-3">
          <TabsList>
            <TabsTrigger value="transactions">
              كل الحركات
              <CountBadge n={rows.length} />
            </TabsTrigger>
            <TabsTrigger value="invoices">فواتير البيع</TabsTrigger>
            <TabsTrigger value="receipts">سندات القبض</TabsTrigger>
            <TabsTrigger value="payments">سندات الصرف</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="transactions" className="px-1 pb-1">
          {isLoading ? (
            <div className="space-y-2 p-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : isError ? (
            <ErrorState title="تعذر تحميل الحركات" onRetry={() => void refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="لا حركات نقدية في هذه الفترة"
              description="جرّب توسيع الفترة أو تغيير العملة من شريط التصفية."
            />
          ) : (
            <div className="w-full overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>التاريخ</TableHead>
                    <TableHead>النوع</TableHead>
                    <TableHead>المستند</TableHead>
                    <TableHead>الطرف</TableHead>
                    <TableHead>الوصف</TableHead>
                    <TableHead className="text-left">وارد</TableHead>
                    <TableHead className="text-left">صادر</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) =>
                    r.kind === "ledger" ? (
                      <LedgerRow key={r.entry.id} e={r.entry} hydrated={hydrated} />
                    ) : (
                      <ManualRow
                        key={r.move.id}
                        m={r.move}
                        hydrated={hydrated}
                        onDelete={onDeleteManual}
                      />
                    ),
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="invoices">
          <SalesInvoicesTable query={query} />
        </TabsContent>

        <TabsContent value="receipts">
          <VoucherTable kind="receipt" query={query} />
        </TabsContent>

        <TabsContent value="payments">
          <VoucherTable kind="payment" query={query} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <span className="mr-1 rounded bg-secondary px-1.5 text-[10px] font-bold text-muted-foreground tabular-nums">
      {n}
    </span>
  );
}

function LedgerRow({ e, hydrated }: { e: LedgerEntry; hydrated: boolean }) {
  const cancelled = e.status === "cancelled";
  return (
    <TableRow className={cn("hover:bg-secondary/40", cancelled && "opacity-60")}>
      <TableCell className="whitespace-nowrap tabular-nums">
        {e.date}
        <span className="mr-1 text-[10px] text-muted-foreground">
          {hydrated && e.createdAt?.length >= 16 ? e.createdAt.slice(11, 16) : ""}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {LEDGER_TYPE_LABEL[e.type as keyof typeof LEDGER_TYPE_LABEL] ?? e.type}
      </TableCell>
      <TableCell>
        {e.invoiceId && INVOICE_LEDGER_TYPES.has(e.type) ? (
          <Link
            to="/invoices/$id"
            params={{ id: e.invoiceId }}
            className="font-semibold tabular-nums text-primary hover:underline"
          >
            {e.referenceNumber || "فاتورة"}
          </Link>
        ) : (
          <span className="tabular-nums">{e.referenceNumber || "—"}</span>
        )}
        {cancelled && (
          <span className="mr-1 rounded bg-destructive/15 px-1 text-[9px] font-bold text-destructive">
            ملغاة
          </span>
        )}
      </TableCell>
      <TableCell>
        {e.partyKind === "customer" ? "عميل" : e.partyKind === "supplier" ? "مورد" : "—"}
      </TableCell>
      <TableCell className="max-w-[200px] truncate">{e.description}</TableCell>
      <TableCell className="text-left tabular-nums" dir="ltr">
        {e.cashImpact === "in" && !cancelled ? formatAmount(e.debit || e.credit, e.currency) : "—"}
      </TableCell>
      <TableCell className="text-left tabular-nums" dir="ltr">
        {e.cashImpact === "out" && !cancelled ? formatAmount(e.debit || e.credit, e.currency) : "—"}
      </TableCell>
      <TableCell />
    </TableRow>
  );
}

function ManualRow({
  m,
  hydrated,
  onDelete,
}: {
  m: ManualMovementDTO;
  hydrated: boolean;
  onDelete: (id: string) => void;
}) {
  return (
    <TableRow className="bg-primary/5 hover:bg-primary/10">
      <TableCell className="whitespace-nowrap tabular-nums">
        {m.date}
        <span className="mr-1 text-[10px] text-muted-foreground">
          {hydrated && m.createdAt?.length >= 16 ? m.createdAt.slice(11, 16) : ""}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {MANUAL_TYPE_LABEL[m.type] ?? m.type}
        <span className="mr-1 rounded bg-primary/20 px-1 text-[9px] font-bold">يدوية</span>
      </TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell className="max-w-[200px] truncate">{m.description}</TableCell>
      <TableCell className="text-left tabular-nums" dir="ltr">
        {m.direction === "in" ? formatAmount(m.amount, m.currency) : "—"}
      </TableCell>
      <TableCell className="text-left tabular-nums" dir="ltr">
        {m.direction === "out" ? formatAmount(m.amount, m.currency) : "—"}
      </TableCell>
      <TableCell>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="حذف الحركة اليدوية"
          className="h-7 w-7 text-destructive"
          onClick={() => onDelete(m.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
