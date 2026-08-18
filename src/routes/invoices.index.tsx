import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { DataPagination } from "@/components/common/DataPagination";
import { Plus, Search, FileText, Ban, Trash2 } from "lucide-react";
import { useCancelInvoice, useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { customers, suppliers } from "@/presentation/hooks/useParties";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { formatDateTime } from "@/lib/utils";
import type { InvoiceFilter } from "@/application/ports/IInvoiceRepository";
import type { Invoice } from "@/domain/entities/Invoice";

const TYPE_LABEL: Record<Invoice["type"], string> = {
  entry: "فاتورة دخول",
  sale: "فاتورة بيع",
  return: "مرتجع",
};

const STATUS_LABEL: Record<NonNullable<InvoiceFilter["status"]>, string> = {
  draft: "مسودة",
  active: "نشطة",
  cancelled: "ملغاة",
};

export const Route = createFileRoute("/invoices/")({
  component: InvoicesIndexPage,
});

function InvoicesIndexPage() {
  const [q, setQ] = useState("");
  const [type, setType] = useState<Invoice["type"] | "all">("all");
  const [status, setStatus] = useState<Invoice["status"] | "all">("all");
  const [partyId, setPartyId] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [toDelete, setToDelete] = useState<Invoice | null>(null);

  const filter: InvoiceFilter = useMemo(() => {
    const f: InvoiceFilter = {};
    if (q.trim()) f.search = q.trim();
    if (type !== "all") f.type = type;
    if (status !== "all") f.status = status;
    if (partyId !== "all") f.partyId = partyId;
    if (from) f.fromDate = from;
    if (to) f.toDate = to;
    f.page = page;
    f.limit = pageSize;
    return f;
  }, [q, type, status, partyId, from, to, page, pageSize]);

  const { data, isLoading, error } = useInvoicesList(filter);
  const invoices = data?.data ?? [];
  const total = data?.total ?? 0;
  const { data: vouchersData } = useVouchersList();
  const allVouchers = vouchersData?.data ?? [];
  const paidByInvoice = (invoiceId: string) =>
    allVouchers
      .filter((v) => v.status === "active" && v.invoiceId === invoiceId)
      .reduce((s, v) => s + v.amount, 0);

  const allParties = [...customers, ...suppliers];

  const cancelInvoice = useCancelInvoice();

  useEffect(() => setPage(0), [q, type, status, partyId, from, to]);

  return (
    <AppShell
      title="الفواتير"
      subtitle="جميع فواتير الشراء والبيع والمرتجعات."
      actions={
        <div className="flex gap-2">
          <Link to="/invoices/entry/new">
            <Button size="sm" className="bg-primary text-primary-foreground">
              <Plus className="h-4 w-4 ml-1" /> فاتورة دخول
            </Button>
          </Link>
          <Link to="/invoices/sale/new">
            <Button size="sm" variant="outline">
              <Plus className="h-4 w-4 ml-1" /> فاتورة بيع
            </Button>
          </Link>
        </div>
      }
    >
      <PageCard
        title="فلاتر البحث"
        description="تصفية الفواتير حسب النوع، الحالة، الطرف، أو التاريخ."
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <div>
            <Label className="text-[11px] text-muted-foreground">بحث</Label>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="رقم الفاتورة أو اسم الطرف"
              className="h-10"
            />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">النوع</Label>
            <Select value={type} onValueChange={(v) => setType(v as Invoice["type"] | "all")}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="entry">فاتورة دخول</SelectItem>
                <SelectItem value="sale">فاتورة بيع</SelectItem>
                <SelectItem value="return">مرتجع</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">الحالة</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as Invoice["status"] | "all")}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="active">نشطة</SelectItem>
                <SelectItem value="cancelled">ملغاة</SelectItem>
                <SelectItem value="draft">مسودة</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">الطرف</Label>
            <Select value={partyId} onValueChange={setPartyId}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                {allParties.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">من تاريخ</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-10"
            />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">إلى تاريخ</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-10"
            />
          </div>
        </div>
      </PageCard>

      <PageCard
        title="الفواتير"
        description={`عرض ${invoices.length} من أصل ${total} فاتورة.`}
        noBodyPadding
      >
        {isLoading && <div className="p-8 text-center text-muted-foreground">جاري التحميل…</div>}
        {error && (
          <div className="p-4 text-center text-destructive">حدث خطأ في تحميل الفواتير.</div>
        )}
        {!isLoading && !error && (
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[900px] text-right text-sm">
              <thead className="bg-secondary/60 text-[11px] font-semibold uppercase text-muted-foreground">
                <tr className="[&>th]:px-3 [&>th]:py-2.5">
                  <th>الرقم</th>
                  <th>النوع</th>
                  <th>الطرف</th>
                  <th>التاريخ</th>
                  <th className="text-left">الإجمالي</th>
                  <th className="text-left">المدفوع</th>
                  <th className="text-left">المتبقي</th>
                  <th>الحالة</th>
                  <th className="text-left">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invoices.map((inv) => {
                  const party = allParties.find((p) => p.id === inv.partyId);
                  const total = inv.total();
                  const isCancelled = inv.status === "cancelled";
                  return (
                    <tr key={inv.id} className={isCancelled ? "bg-destructive/5" : ""}>
                      <td className="px-3 py-2 font-mono text-xs text-primary">
                        <Link
                          to="/invoices/$id"
                          params={{ id: inv.id }}
                          className="hover:underline"
                        >
                          {inv.number}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{TYPE_LABEL[inv.type]}</td>
                      <td className="px-3 py-2">{party?.name ?? "—"}</td>
                      <td className="px-3 py-2 tabular-nums">{formatDateTime(inv.createdAt)}</td>
                      <td className="px-3 py-2 text-left tabular-nums">
                        {formatAmount(total, inv.currency)}
                      </td>
                      <td className="px-3 py-2 text-left tabular-nums">
                        {formatAmount(paidByInvoice(inv.id), inv.currency)}
                      </td>
                      <td className="px-3 py-2 text-left tabular-nums">
                        {formatAmount(Math.max(0, total - paidByInvoice(inv.id)), inv.currency)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            isCancelled
                              ? "text-muted-foreground"
                              : inv.status === "active"
                                ? "text-success"
                                : "text-warning"
                          }
                        >
                          {STATUS_LABEL[inv.status as Invoice["status"]]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-left">
                        {!isCancelled && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setToDelete(inv)}
                            aria-label="حذف"
                          >
                            <Trash2 className="ml-1 h-4 w-4" /> حذف
                          </Button>
                        )}
                        <Link to="/invoices/$id" params={{ id: inv.id }}>
                          <Button size="sm" variant="ghost">
                            <FileText className="h-4 w-4" />
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {invoices.length === 0 && (
                  <tr>
                    <td colSpan={9} className="p-10 text-center text-muted-foreground">
                      لا توجد فواتير مطابقة.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {!isLoading && !error && (
          <DataPagination
            total={total}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(0);
            }}
          />
        )}
      </PageCard>

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من حذف الفاتورة "{toDelete?.number}"؟ لا يمكن التراجع عن هذا الإجراء.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogAction
              onClick={() => {
                if (toDelete) void cancelInvoice.mutateAsync(toDelete.id);
                setToDelete(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              حذف نهائي
            </AlertDialogAction>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
