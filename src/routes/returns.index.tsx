import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Plus, Printer } from "lucide-react";
import { useState } from "react";
import { RETURN_REASONS } from "@/presentation/hooks/useReturns";
import { useReturnsList, useCancelReturn } from "@/presentation/hooks/useReturns";
import { customerById, supplierById } from "@/presentation/hooks/useParties";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { formatDateTime } from "@/lib/utils";
import { printDocument } from "@/components/print/printPortal";
import { ReturnInvoicePrint } from "@/components/print/invoices/ReturnInvoicePrint";
import { useInventory } from "@/presentation/hooks/useInventory";
import { toast } from "sonner";
import type { Currency } from "@/domain/types";
import type { ReturnDTO } from "@/application/ports/IReturnRepository";

export const Route = createFileRoute("/returns/")({ component: ReturnsList });

function ReturnsList() {
  useInventory();
  const { data: paginated } = useReturnsList();
  const returns = paginated?.data ?? [];
  const cancelReturn = useCancelReturn();
  const [kind, setKind] = useState<"all" | "entry" | "sale">("all");
  const list = returns.filter((r) => kind === "all" || r.kind === kind);

  const handlePrint = (r: ReturnDTO) => {
    try {
      printDocument(<ReturnInvoicePrint returnDoc={r} />);
    } catch (e) {
      toast.error(`فشل تحضير المستند للطباعة: ${e instanceof Error ? e.message : ""}`);
    }
  };
  return (
    <AppShell
      title="المرتجعات"
      subtitle="مرتجع الدخول (للمورد) ومرتجع البيع (من العميل)."
      actions={
        <div className="flex gap-2">
          <Link to="/returns/entry/new">
            <Button variant="outline">
              <Plus className="h-4 w-4 ml-1" /> مرتجع دخول
            </Button>
          </Link>
          <Link to="/returns/sale/new">
            <Button className="bg-primary text-primary-foreground">
              <Plus className="h-4 w-4 ml-1" /> مرتجع بيع
            </Button>
          </Link>
        </div>
      }
    >
      <PageCard title="فلاتر" description="حسب النوع.">
        <div className="flex gap-2 text-sm">
          {[
            ["all", "الكل"],
            ["entry", "مرتجع دخول"],
            ["sale", "مرتجع بيع"],
          ].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setKind(k as typeof kind)}
              className={`px-3 py-1.5 rounded ${kind === k ? "bg-primary text-primary-foreground" : "bg-secondary"}`}
            >
              {l}
            </button>
          ))}
        </div>
      </PageCard>

      <PageCard title="القائمة" description={`${list.length} مرتجع.`} noBodyPadding>
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[900px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                <th>الرقم</th>
                <th>التاريخ</th>
                <th>النوع</th>
                <th>الطرف</th>
                <th>الفاتورة</th>
                <th className="text-left">الكمية (كغ)</th>
                <th className="text-left">القيمة</th>
                <th>السبب</th>
                <th>الحالة</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((r) => {
                const party =
                  r.kind === "entry" ? supplierById(r.partyId) : customerById(r.partyId);
                const totalKg = r.lines.reduce((s, l) => s + l.quantityKg, 0);
                const totalVal = r.lines.reduce((s, l) => s + l.quantityKg * l.pricePerKg, 0);
                const reason = RETURN_REASONS.find((x) => x.code === r.reason)?.label ?? "—";
                return (
                  <tr
                    key={r.id}
                    className={r.status === "cancelled" ? "text-muted-foreground line-through" : ""}
                  >
                    <td className="px-3 py-2 tabular-nums font-semibold">{r.number}</td>
                    <td className="px-3 py-2 tabular-nums">{formatDateTime(r.createdAt)}</td>
                    <td className="px-3 py-2">{r.kind === "entry" ? "مرتجع دخول" : "مرتجع بيع"}</td>
                    <td className="px-3 py-2">{party?.name ?? "—"}</td>
                    <td className="px-3 py-2 text-primary">
                      {r.originalInvoiceId ? (
                        <Link to="/invoices/$id" params={{ id: r.originalInvoiceId }}>
                          {r.originalInvoiceId}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums">{totalKg}</td>
                    <td className="px-3 py-2 text-left tabular-nums font-bold">
                      {formatAmount(totalVal, r.currency as Currency)}
                    </td>
                    <td className="px-3 py-2 text-xs">{reason}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.status === "active" ? "نشطة" : "ملغاة"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handlePrint(r)}
                          title="طباعة المرتجع"
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                        {r.status === "active" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              confirm(`إلغاء المرتجع ${r.number}؟`) && cancelReturn.mutate(r.id)
                            }
                          >
                            إلغاء
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-10 text-center text-muted-foreground">
                    لا مرتجعات.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </PageCard>
    </AppShell>
  );
}
