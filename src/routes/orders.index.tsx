import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ClipboardList, Plus, Search, Trash2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { BulkSelectToolbar } from "@/components/common/BulkSelectToolbar";
import { ConfirmBulkAction } from "@/components/common/ConfirmBulkAction";
import { useOrdersList, useCancelOrder, type Order } from "@/presentation/hooks/useOrders";
import type { OrderStatus } from "@/domain/entities/Order";
import { cn, formatDateTime } from "@/lib/utils";

export const Route = createFileRoute("/orders/")({
  component: OrdersIndexPage,
  head: () => ({
    meta: [
      { title: "طلبات العملاء" },
      {
        name: "description",
        content: "إدارة طلبات العملاء للأقمشة غير المتوفرة حالياً في المخزون.",
      },
    ],
  }),
});

const STATUS_LABEL: Record<OrderStatus, string> = {
  open: "مفتوح",
  partially_available: "متوفر جزئياً",
  available: "متوفر",
  fulfilled: "تم التنفيذ",
  cancelled: "ملغى",
};

const STATUS_TONE: Record<OrderStatus, string> = {
  open: "bg-secondary text-foreground",
  partially_available: "bg-warning/15 text-warning",
  available: "bg-success/15 text-success",
  fulfilled: "bg-primary/15 text-primary",
  cancelled: "bg-destructive/10 text-destructive",
};

function availabilityFromStatus(status: OrderStatus): "full" | "partial" | "none" {
  if (status === "available") return "full";
  if (status === "partially_available") return "partial";
  return "none";
}

function OrdersIndexPage() {
  const { data: paginated } = useOrdersList();
  const orders = useMemo(() => paginated?.data ?? [], [paginated?.data]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | OrderStatus>("all");
  const cancelOrderMut = useCancelOrder();

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [bulkTarget, setBulkTarget] = useState<{ items: Order[] } | null>(null);
  // Individual (per-item) cancel — حذف فردي لكل عنصر (soft cancel, not a DB delete).
  const [toCancel, setToCancel] = useState<Order | null>(null);

  // Only orders that are not already cancelled/fulfilled can be cancelled.
  const cancellable = useMemo(
    () => orders.filter((o) => o.status !== "cancelled" && o.status !== "fulfilled"),
    [orders],
  );
  const selectionCount = Object.keys(selectedIds).length;

  const enterSelectMode = () => setSelectMode(true);
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds({});
  };
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const n = { ...prev };
      if (n[id]) delete n[id];
      else n[id] = true;
      return n;
    });
  };
  const selectAll = () => {
    const n: Record<string, boolean> = {};
    cancellable.forEach((o) => (n[o.id] = true));
    setSelectedIds(n);
  };
  const requestBulkCancel = () => {
    if (selectionCount === 0) return;
    setBulkTarget({ items: cancellable.filter((o) => selectedIds[o.id]) });
  };
  const confirmBulkCancel = () => {
    if (!bulkTarget) return;
    bulkTarget.items.forEach((o) => cancelOrderMut.mutate(o.id));
    setBulkTarget(null);
    exitSelectMode();
  };

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (!q) return true;
      return (
        o.code.toLowerCase().includes(q) ||
        o.customerNameSnapshot.toLowerCase().includes(q) ||
        (o.customerPhoneSnapshot ?? "").includes(q)
      );
    });
  }, [query, statusFilter, orders]);

  return (
    <AppShell
      title="طلبات العملاء"
      subtitle="سجّل طلبات لم يتوفر لها مخزون بعد — يتم تنبيهك عند دخول أقمشة مطابقة."
      actions={
        <div className="flex items-center gap-2">
          <BulkSelectToolbar
            active={selectMode}
            count={selectionCount}
            idleLabel="إلغاء متعدد"
            actionLabel="إلغاء المحدد"
            canConfirm={selectionCount > 0}
            canSelectAll={cancellable.length > 0}
            onEnter={enterSelectMode}
            onExit={exitSelectMode}
            onSelectAll={selectAll}
            onAction={requestBulkCancel}
          />
          <Link
            to="/orders/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-bold text-primary-foreground shadow-sm transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> طلب جديد
          </Link>
        </div>
      }
    >
      <PageCard
        title="القائمة"
        description={`${rows.length} طلب`}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ابحث برقم الطلب / العميل"
                className="h-8 w-56 pr-7 text-xs"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as "all" | OrderStatus)}
            >
              <SelectTrigger className="!h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الحالات</SelectItem>
                <SelectItem value="open">مفتوح</SelectItem>
                <SelectItem value="partially_available">متوفر جزئياً</SelectItem>
                <SelectItem value="available">متوفر</SelectItem>
                <SelectItem value="fulfilled">تم التنفيذ</SelectItem>
                <SelectItem value="cancelled">ملغى</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
        noBodyPadding
      >
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
            <ClipboardList className="h-8 w-8 opacity-50" />
            <p className="text-sm">لا توجد طلبات بعد.</p>
            <Link
              to="/orders/new"
              className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground"
            >
              <Plus className="h-3.5 w-3.5" /> أضف أول طلب
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-secondary/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                {selectMode && <th className="w-10"></th>}
                <th className="px-3 py-2 text-right font-semibold">رقم</th>
                <th className="px-3 py-2 text-right font-semibold">العميل</th>
                <th className="px-3 py-2 text-right font-semibold">التاريخ</th>
                <th className="px-3 py-2 text-right font-semibold">بنود</th>
                <th className="px-3 py-2 text-right font-semibold">الحالة</th>
                <th className="px-3 py-2 text-right font-semibold">التوفر</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const avail = availabilityFromStatus(o.status);
                const availLabel =
                  avail === "full"
                    ? "متوفر بالكامل"
                    : avail === "partial"
                      ? "متوفر جزئياً"
                      : "غير متوفر";
                const availTone =
                  avail === "full"
                    ? "text-success"
                    : avail === "partial"
                      ? "text-warning"
                      : "text-muted-foreground";
                return (
                  <tr key={o.id} className="border-t border-border hover:bg-secondary/30">
                    {selectMode && (
                      <td className="px-3 py-2 text-center">
                        {(o.status === "cancelled" || o.status === "fulfilled") ? (
                          <span className="inline-block h-4 w-4" />
                        ) : (
                          <Checkbox
                            checked={!!selectedIds[o.id]}
                            onCheckedChange={() => toggleSelect(o.id)}
                            aria-label={`تحديد طلب ${o.code}`}
                          />
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2 font-mono tabular-nums">{o.code}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">{o.customerNameSnapshot}</div>
                      {o.customerPhoneSnapshot && (
                        <div dir="ltr" className="text-[11px] tabular-nums text-muted-foreground">
                          {o.customerPhoneSnapshot}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {formatDateTime(o.createdAt)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{o.items.length}</td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "inline-flex items-center rounded px-2 py-0.5 text-[10.5px] font-bold",
                          STATUS_TONE[o.status],
                        )}
                      >
                        {STATUS_LABEL[o.status]}
                      </span>
                    </td>
                    <td className={cn("px-3 py-2 text-[11.5px] font-semibold", availTone)}>
                      {availLabel}
                    </td>
                    <td className="px-3 py-2 text-left">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          to="/orders/$id"
                          params={{ id: o.id }}
                          className="text-xs font-semibold text-primary hover:underline"
                        >
                          عرض
                        </Link>
                        {o.status !== "cancelled" && o.status !== "fulfilled" && (
                          <button
                            type="button"
                            onClick={() => setToCancel(o)}
                            aria-label={`حذف فردي للطلب ${o.code}`}
                            title="حذف فردي"
                            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </PageCard>

      <ConfirmBulkAction
        open={!!bulkTarget}
        title="تأكيد الإلغاء"
        description={`هل أنت متأكد من إلغاء ${bulkTarget?.items.length ?? 0} طلب؟ لا يمكن التراجع عن هذا الإجراء.`}
        confirmLabel={`إلغاء ${bulkTarget?.items.length ?? 0} طلب`}
        items={(bulkTarget?.items ?? []).map((o) => ({
          key: o.id,
          name: `${o.code} — ${o.customerNameSnapshot}`,
        }))}
        onCancel={() => setBulkTarget(null)}
        onConfirm={confirmBulkCancel}
      />

      {/* حذف فردي لكل عنصر — gets individual order confirmed then soft-cancelled (status → cancelled). */}
      <AlertDialog open={!!toCancel} onOpenChange={(o) => !o && setToCancel(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد إلغاء الطلب</AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من إلغاء الطلب "{toCancel?.code}" للعميل {toCancel?.customerNameSnapshot}؟
              لا يمكن التراجع عن هذا الإجراء.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogAction
              onClick={() => {
                if (toCancel) cancelOrderMut.mutate(toCancel.id);
                setToCancel(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              إلغاء الطلب
            </AlertDialogAction>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
