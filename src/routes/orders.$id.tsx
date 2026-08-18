import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Ban, CheckCircle2, Package, ShoppingCart } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { useOrder, useCancelOrder, matchRollsForItem, orderAvailability, type OrderStatus } from "@/presentation/hooks/useOrders";
import { rollById, useInventory } from "@/presentation/hooks/useInventory";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/orders/$id")({
  loader: ({ params }) => {
    return { id: params.id };
  },
  component: OrderDetailPage,
  notFoundComponent: () => (
    <AppShell title="طلب غير موجود">
      <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-foreground">
        الطلب المطلوب غير موجود.
      </div>
    </AppShell>
  ),
});

const STATUS_LABEL: Record<OrderStatus, string> = {
  open: "مفتوح",
  partially_available: "متوفر جزئياً",
  available: "متوفر",
  fulfilled: "تم التنفيذ",
  cancelled: "ملغى",
};

function OrderDetailPage() {
  useInventory();
  const { id } = Route.useParams();
  const navigate = useNavigate();

  const { data: o } = useOrder(id);
  const cancelOrderMut = useCancelOrder();

  if (!o) return null;

  const avail = orderAvailability(o);
  const canFulfill = avail !== "none" && o.status !== "fulfilled" && o.status !== "cancelled";

  return (
    <AppShell
      title={`طلب ${o.code}`}
      subtitle={`${o.customerNameSnapshot} • ${o.date}`}
      actions={
        <div className="flex items-center gap-2">
          {o.status !== "cancelled" && o.status !== "fulfilled" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm("إلغاء الطلب؟")) cancelOrderMut.mutate(o.id);
              }}
              className="gap-1.5"
            >
              <Ban className="h-3.5 w-3.5" /> إلغاء
            </Button>
          )}
          {canFulfill && (
            <Button
              size="sm"
              onClick={() =>
                navigate({
                  to: "/invoices/sale/new",
                  search: { fromOrder: o.id } as never,
                })
              }
              className="gap-1.5"
            >
              <ShoppingCart className="h-3.5 w-3.5" /> حوّل لفاتورة بيع
            </Button>
          )}
          <Link
            to="/orders"
            className="text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            ← العودة للقائمة
          </Link>
        </div>
      }
    >
      <div className="space-y-3">
        <PageCard title="حالة الطلب">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Info label="رقم" value={o.code} />
            <Info label="الزبون" value={o.customerNameSnapshot} />
            <Info label="الهاتف" value={o.customerPhoneSnapshot ?? "—"} />
            <Info
              label="الحالة"
              value={STATUS_LABEL[o.status]}
              tone={
                o.status === "fulfilled"
                  ? "text-primary"
                  : o.status === "cancelled"
                    ? "text-destructive"
                    : "text-foreground"
              }
            />
            <Info
              label="التوفر الحالي"
              value={
                avail === "full"
                  ? "متوفر بالكامل"
                  : avail === "partial"
                    ? "متوفر جزئياً"
                    : "غير متوفر"
              }
              tone={
                avail === "full"
                  ? "text-success"
                  : avail === "partial"
                    ? "text-warning"
                    : "text-muted-foreground"
              }
            />
            {o.notes && <Info label="ملاحظات" value={o.notes} />}
          </div>
        </PageCard>

        <PageCard title="بنود الطلب" description={`${o.items.length} بند`} noBodyPadding>
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-right font-semibold">#</th>
                <th className="px-3 py-2 text-right font-semibold">القماش</th>
                <th className="px-3 py-2 text-right font-semibold">اللون</th>
                <th className="px-3 py-2 text-right font-semibold">مطلوب</th>
                <th className="px-3 py-2 text-right font-semibold">متوفر</th>
                <th className="px-3 py-2 text-right font-semibold">الصبغات المطابقة</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((it, i) => {
                const m = matchRollsForItem(it);
                const full = m.availableKg >= it.requestedKg;
                return (
                  <tr key={it.id} className="border-t border-border">
                    <td className="px-3 py-2 tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2">{it.fabricName}</td>
                    <td className="px-3 py-2">
                      {it.colorName}
                      {it.colorCode && (
                        <span className="mr-1.5 text-[10px] tabular-nums text-muted-foreground">
                          ({it.colorCode})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{it.requestedKg} كغ</td>
                    <td
                      className={cn(
                        "px-3 py-2 font-semibold tabular-nums",
                        full
                          ? "text-success"
                          : m.availableKg > 0
                            ? "text-warning"
                            : "text-muted-foreground",
                      )}
                    >
                      {m.availableKg} كغ
                      {full && <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />}
                    </td>
                    <td className="px-3 py-2 text-[11.5px] text-muted-foreground">
                      {m.rollIds.length === 0 ? (
                        <span className="opacity-60">—</span>
                      ) : (
                        m.rollIds
                          .map((rid) => {
                            const r = rollById(rid);
                            return r ? `#${r.rollNo} (${r.remainingKg} كغ)` : null;
                          })
                          .filter(Boolean)
                          .join(" • ")
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </PageCard>

        {canFulfill && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-success/40 bg-success/5 px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <Package className="h-4 w-4 text-success" />
              <span className="font-semibold text-foreground">
                يمكنك تنفيذ هذا الطلب الآن — يوجد مخزون مطابق.
              </span>
            </div>
            <Button
              size="sm"
              onClick={() =>
                navigate({
                  to: "/invoices/sale/new",
                  search: { fromOrder: o.id } as never,
                })
              }
              className="gap-1.5"
            >
              <ShoppingCart className="h-3.5 w-3.5" /> حوّل لفاتورة بيع
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {o.status === "fulfilled" && o.fulfilledInvoiceId && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
            تم تنفيذ الطلب في الفاتورة{" "}
            <Link
              to="/invoices/$id"
              params={{ id: o.fulfilledInvoiceId }}
              className="font-bold text-primary hover:underline"
            >
              {o.fulfilledInvoiceId}
            </Link>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 text-sm font-semibold", tone ?? "text-foreground")}>{value}</div>
    </div>
  );
}
