import { useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import type { ProfitQueryParams } from "@/contracts/profit";

/**
 * Receipts / Payments TABLE (embedded in the Activity tab).
 * kind="receipt" → سندات القبض، kind="payment" → سندات الصرف.
 * One shared implementation — no duplicated tables or logic.
 */
export function VoucherTable({
  kind,
  query,
}: {
  kind: "receipt" | "payment";
  query: ProfitQueryParams;
}) {
  const { data, isLoading, isError, refetch, error } = useVouchersList({ limit: 1000 });

  useEffect(() => {
    if (error) console.error(`[cashbox] ${kind} vouchers failed:`, error);
  }, [error, kind]);

  if (isLoading) {
    return (
      <div className="space-y-2 p-1">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <ErrorState
        title={kind === "receipt" ? "تعذر تحميل سندات القبض" : "تعذر تحميل سندات الصرف"}
        onRetry={() => void refetch()}
      />
    );
  }

  const rows = (data?.data ?? []).filter(
    (v) =>
      v.kind === kind &&
      v.status !== "cancelled" &&
      (!query.fromDate || v.date >= query.fromDate) &&
      (!query.toDate || v.date <= query.toDate) &&
      (!query.currency || v.currency === query.currency),
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title={kind === "receipt" ? "لا سندات قبض في هذه الفترة" : "لا سندات صرف في هذه الفترة"}
        description="جرّب توسيع الفترة من شريط التصفية."
      />
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>رقم السند</TableHead>
            <TableHead>التاريخ</TableHead>
            <TableHead>العملة</TableHead>
            <TableHead className="text-left">المبلغ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((v) => (
            <TableRow key={v.id} className="hover:bg-secondary/40">
              <TableCell className="font-semibold tabular-nums">{v.number}</TableCell>
              <TableCell className="tabular-nums">{v.date}</TableCell>
              <TableCell>{v.currency}</TableCell>
              <TableCell className="text-left font-bold tabular-nums" dir="ltr">
                {formatAmount(v.amount, v.currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
