import { useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { BulkSelectToolbar } from "@/components/common/BulkSelectToolbar";
import { ConfirmBulkAction } from "@/components/common/ConfirmBulkAction";
import {
  useVouchersList,
  useCancelVoucher,
  type Voucher,
} from "@/presentation/hooks/useVouchers";
import { supplierById } from "@/presentation/hooks/useParties";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { formatDateTime } from "@/lib/utils";

export const Route = createFileRoute("/payments/")({ component: PaymentsList });

function PaymentsList() {
  const { data: listData } = useVouchersList({ kind: "payment" });
  const list = listData?.data ?? [];
  const cancelVoucherMut = useCancelVoucher();

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [bulkTarget, setBulkTarget] = useState<{ items: Voucher[] } | null>(null);

  const activeList = useMemo(() => list.filter((v) => v.status === "active"), [list]);
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
    activeList.forEach((v) => (n[v.id] = true));
    setSelectedIds(n);
  };
  const requestBulkCancel = () => {
    if (selectionCount === 0) return;
    setBulkTarget({ items: activeList.filter((v) => selectedIds[v.id]) });
  };
  const confirmBulkCancel = () => {
    if (!bulkTarget) return;
    bulkTarget.items.forEach((v) => cancelVoucherMut.mutate(v.id));
    setBulkTarget(null);
    exitSelectMode();
  };

  return (
    <AppShell
      title="سندات الصرف"
      subtitle="مبالغ مدفوعة للموردين — كل سند يُقيَّد فوراً في دفتر الحركات."
      actions={
        <div className="flex items-center gap-2">
          <BulkSelectToolbar
            active={selectMode}
            count={selectionCount}
            idleLabel="إلغاء متعدد"
            actionLabel="إلغاء المحدد"
            canConfirm={selectionCount > 0}
            canSelectAll={activeList.length > 0}
            onEnter={enterSelectMode}
            onExit={exitSelectMode}
            onSelectAll={selectAll}
            onAction={requestBulkCancel}
          />
          <Link to="/payments/new">
            <Button className="bg-primary text-primary-foreground">
              <Plus className="h-4 w-4 ml-1" /> سند صرف جديد
            </Button>
          </Link>
        </div>
      }
    >
      <PageCard title="القائمة" description={`${list.length} سند مسجل.`} noBodyPadding>
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[800px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                {selectMode && <th className="w-10"></th>}
                <th>رقم السند</th>
                <th>التاريخ</th>
                <th>المورد</th>
                <th>الفاتورة</th>
                <th className="text-left">المبلغ</th>
                <th>طريقة الدفع</th>
                <th>الحالة</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((v) => {
                const s = supplierById(v.partyId);
                const muted = v.status === "cancelled";
                return (
                  <tr key={v.id} className={muted ? "text-muted-foreground line-through" : ""}>
                    {selectMode && (
                      <td className="px-3 py-2">
                        {v.status === "active" && (
                          <Checkbox
                            checked={!!selectedIds[v.id]}
                            onCheckedChange={() => toggleSelect(v.id)}
                            aria-label={`تحديد سند ${v.number}`}
                          />
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2 tabular-nums font-semibold">{v.number}</td>
                    <td className="px-3 py-2 tabular-nums">{formatDateTime(v.createdAt)}</td>
                    <td className="px-3 py-2">{s?.name ?? "—"}</td>
                    <td className="px-3 py-2 text-primary">
                      {v.invoiceId ? (
                        <Link to="/invoices/$id" params={{ id: v.invoiceId }}>
                          {v.invoiceId}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">دفعة عامة</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums font-bold">
                      {formatAmount(v.amount, v.currency)}
                    </td>
                    <td className="px-3 py-2">
                      {v.method === "cash" ? "نقدي" : v.method === "transfer" ? "تحويل" : "شيك"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {v.status === "active" ? "نشطة" : "ملغاة"}
                    </td>
                    <td className="px-3 py-2">
                      {v.status === "active" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            confirm(`إلغاء سند الصرف ${v.number}؟`) && cancelVoucherMut.mutate(v.id)
                          }
                        >
                          إلغاء
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && (
                <tr>
                  <td colSpan={selectMode ? 9 : 8} className="p-10 text-center text-muted-foreground">
                    لا سندات بعد.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </PageCard>

      <ConfirmBulkAction
        open={!!bulkTarget}
        title="تأكيد الإلغاء"
        description={`هل أنت متأكد من إلغاء ${bulkTarget?.items.length ?? 0} سند صرف؟ لا يمكن التراجع عن هذا الإجراء.`}
        confirmLabel={`إلغاء ${bulkTarget?.items.length ?? 0} سند`}
        items={(bulkTarget?.items ?? []).map((v) => ({
          key: v.id,
          name: `${v.number} — ${supplierById(v.partyId)?.name ?? "—"}`,
        }))}
        onCancel={() => setBulkTarget(null)}
        onConfirm={confirmBulkCancel}
      />
    </AppShell>
  );
}
