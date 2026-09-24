import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Pencil, Printer, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { useCancelVoucher, useVouchersList, type Voucher } from "@/presentation/hooks/useVouchers";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { printDocument } from "@/components/print/printPortal";
import { VoucherPrintDocument } from "@/components/print/VoucherPrintDocument";
import type { ProfitQueryParams } from "@/contracts/profit";

/**
 * Receipts / Payments TABLE (embedded in the Activity tab).
 * kind="receipt" → سندات القبض، kind="payment" → سندات الصرف.
 */
export function VoucherTable({
  kind,
  query,
}: {
  kind: "receipt" | "payment";
  query: ProfitQueryParams;
}) {
  // Period/status filters run on the server — only this period's vouchers are
  // fetched, not the whole voucher history.
  const { data, isLoading, isError, refetch, error } = useVouchersList(
    {
      kind,
      status: "active",
      ...(query.fromDate ? { fromDate: query.fromDate } : {}),
      ...(query.toDate ? { toDate: query.toDate } : {}),
    },
    { all: true },
  );
  const cancelMut = useCancelVoucher();
  const [toCancel, setToCancel] = useState<Voucher | null>(null);

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

  const editTo = kind === "receipt" ? "/receipts/new" : "/payments/new";

  return (
    <>
      <div className="w-full overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>رقم السند</TableHead>
              <TableHead>التاريخ</TableHead>
              <TableHead>العملة</TableHead>
              <TableHead className="text-left">المبلغ</TableHead>
              <TableHead className="text-left">إجراءات</TableHead>
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
                <TableCell className="text-left">
                  <div className="inline-flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => printDocument(<VoucherPrintDocument voucher={v as never} />)}
                    >
                      <Printer className="ml-1 h-4 w-4" /> طباعة
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <Link to={editTo} search={{ edit: v.id }}>
                        <Pencil className="ml-1 h-4 w-4" /> تعديل
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setToCancel(v)}
                    >
                      <Trash2 className="ml-1 h-4 w-4" /> حذف
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!toCancel} onOpenChange={(o) => !o && setToCancel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من إلغاء السند "{toCancel?.number}"؟ لا يمكن التراجع عن هذا الإجراء.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (toCancel) cancelMut.mutate(toCancel.id);
                setToCancel(null);
              }}
            >
              حذف نهائي
            </AlertDialogAction>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
