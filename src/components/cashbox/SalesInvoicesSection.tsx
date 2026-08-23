import { useEffect, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Eye, MoreVertical, Pencil, Printer } from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useProfitDetails } from "@/presentation/hooks/useProfit";
import { customerById, supplierById } from "@/presentation/hooks/useParties";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { printDocument } from "@/components/print/printPortal";
import { InvoicePrintDocument } from "@/components/print/InvoicePrintDocument";
import { formatNumber, formatQuantity } from "@/shared/utils/formatNumber";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import type { Currency } from "@/domain/types";
import type { Invoice } from "@/domain/entities/Invoice";
import type { ProfitQueryParams } from "@/contracts/profit";

const EDIT_ROLES = new Set(["admin", "accountant"]);

/**
 * Sale-invoices TABLE (embedded inside the Activity tab — no card wrapper).
 * Reuses the existing invoice list service; actions use the system's own
 * View/Edit/Print paths via a labeled ⋮ menu. Errors are friendly+retryable.
 */
export function SalesInvoicesTable({ query }: { query: ProfitQueryParams }) {
  const navigate = useNavigate();
  const canEdit = EDIT_ROLES.has(buildTenantContext().userRole);

  const filter = {
    type: "sale" as const,
    status: "active" as const,
    fromDate: query.fromDate,
    toDate: query.toDate,
    ...(query.currency ? { currency: query.currency } : {}),
    limit: 500,
  };
  const { data, isLoading, isError, refetch, error } = useInvoicesList(filter);
  const { data: profitDetails } = useProfitDetails(query);
  const { data: vouchersData } = useVouchersList({ limit: 1000 });

  useEffect(() => {
    if (error) console.error("[cashbox] invoices list failed:", error);
  }, [error]);

  const cogsByInvoice = useMemo(() => {
    const m = new Map<string, { cogs: number; grossProfit: number }>();
    for (const l of profitDetails?.invoiceLines ?? []) {
      m.set(l.invoiceId, { cogs: l.cogs, grossProfit: l.grossProfit });
    }
    return m;
  }, [profitDetails]);

  const paidByInvoice = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of vouchersData?.data ?? []) {
      if (v.kind !== "receipt" || v.status !== "active" || !v.invoiceId) continue;
      m.set(v.invoiceId, (m.get(v.invoiceId) ?? 0) + v.amount);
    }
    return m;
  }, [vouchersData]);

  if (isLoading) {
    return (
      <div className="space-y-2 p-1">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return <ErrorState title="تعذر تحميل الفواتير" onRetry={() => void refetch()} />;
  }

  const invoices = data?.data ?? [];
  if (invoices.length === 0) {
    return (
      <EmptyState
        title="لا فواتير بيع في هذه الفترة"
        description="جرّب توسيع الفترة من شريط التصفية أعلى الصفحة."
      />
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>الفاتورة</TableHead>
            <TableHead>العميل</TableHead>
            <TableHead>التاريخ</TableHead>
            <TableHead className="text-left">الإجمالي</TableHead>
            <TableHead className="text-left">المقبوض</TableHead>
            <TableHead className="text-left">المتبقي</TableHead>
            <TableHead className="text-left">الربح</TableHead>
            <TableHead className="text-center">إجراءات</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((inv) => {
            const total = inv.total();
            const paid = paidByInvoice.get(inv.id) ?? 0;
            const remaining = Math.max(0, total - paid);
            const pf = cogsByInvoice.get(inv.id);
            return (
              <TableRow key={inv.id} className="hover:bg-secondary/40">
                <TableCell>
                  <Link
                    to="/invoices/$id"
                    params={{ id: inv.id }}
                    className="font-semibold tabular-nums text-primary hover:underline"
                  >
                    {inv.number}
                  </Link>
                </TableCell>

                <TableCell className="max-w-[140px] truncate">{partyNameOf(inv)}</TableCell>
                <TableCell className="tabular-nums">{inv.date}</TableCell>
                <TableCell className="text-left tabular-nums" dir="ltr">
                  {formatQuantity(total)} {currencySymbol(inv.currency as Currency)}
                </TableCell>
                <TableCell className="text-left tabular-nums" dir="ltr">
                  {formatNumber(paid)} {currencySymbol(inv.currency as Currency)}
                </TableCell>
                <TableCell className="text-left font-semibold tabular-nums" dir="ltr">
                  {formatNumber(remaining)} {currencySymbol(inv.currency as Currency)}
                </TableCell>
                <TableCell
                  className={`text-left font-bold tabular-nums ${
                    (pf?.grossProfit ?? 0) < 0 ? "text-destructive" : ""
                  }`}
                  dir="ltr"
                >
                  {pf ? formatNumber(pf.grossProfit) : "—"}
                </TableCell>
                <TableCell className="text-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" aria-label={`إجراءات ${inv.number}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {/* View — always available, opens the REAL invoice page */}
                      <DropdownMenuItem asChild>
                        <Link
                          to="/invoices/$id"
                          params={{ id: inv.id }}
                          className="flex w-full items-center gap-2"
                        >
                          <Eye className="h-4 w-4" /> عرض
                        </Link>
                      </DropdownMenuItem>
                      {/* Edit — the system's ORIGINAL edit screen (role-gated UI; server enforces too) */}
                      {canEdit && inv.status === "active" && (
                        <DropdownMenuItem
                          onClick={() =>
                            navigate({ to: "/invoices/sale/new", search: { edit: inv.id } })
                          }
                        >
                          <Pencil className="h-4 w-4" /> تعديل
                        </DropdownMenuItem>
                      )}
                      {/* Print — the SAME print document used by /invoices/$id */}
                      <DropdownMenuItem
                        onClick={() => printDocument(<InvoicePrintDocument invoice={inv} />)}
                      >
                        <Printer className="h-4 w-4" /> طباعة
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Party name via the shared parties store. */
function partyNameOf(inv: Invoice): string {
  return customerById(inv.partyId)?.name ?? supplierById(inv.partyId)?.name ?? "—";
}



