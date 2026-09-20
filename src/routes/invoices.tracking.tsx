import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Eye,
  FileStack,
  History,
  Pencil,
  Printer,
  Trash2,
  Plus,
  Minus,
  ArrowLeftRight,
  XCircle,
  CheckCircle2,
  PencilLine,
} from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
import { useCancelInvoice, useInvoicesList, useInvoice } from "@/presentation/hooks/useInvoices";
import { useReturnsList } from "@/presentation/hooks/useReturns";
import { usePrintJobs } from "@/presentation/hooks/usePrintJobs";
import { useInvoiceAudit } from "@/presentation/hooks/useAudit";
import type { AuditLogDTO } from "@/infrastructure/api/AuditApiService";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { formatDateTime } from "@/lib/utils";
import { formatNumber } from "@/shared/utils/formatNumber";
import { customers, suppliers } from "@/presentation/hooks/useParties";
import { useInventory } from "@/presentation/hooks/useInventory";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import type { InvoiceFilter } from "@/application/ports/IInvoiceRepository";
import type { Invoice } from "@/domain/entities/Invoice";
import { InvoicePrintView } from "@/components/invoices/InvoicePrintView";
import { printDocument, printOrArchive } from "@/components/print/printPortal";
import { archiveMeta } from "@/shared/utils/documentArchive";
import { PrintPageBreak } from "@/components/print/PrintDocument";
import { InvoicePrintDocument } from "@/components/print/InvoicePrintDocument";

type TrackKind = "all" | "entry" | "sale" | "return" | "print_send" | "print_receive";

type TrackRow = {
  id: string;
  kind: Exclude<TrackKind, "all">;
  number: string;
  date: string;
  partyName: string;
  totalLabel: string;
  statusLabel: string;
  href: string;
};

function printInvoiceWithArchive(inv: Invoice) {
  const node = <InvoicePrintDocument invoice={inv} />;
  if (inv.type === "sale" || inv.type === "entry") {
    printOrArchive(
      node,
      archiveMeta(inv.type, {
        date: inv.date,
        typeLabel: inv.type === "entry" ? "ENTRY" : "SALE",
        number: inv.number || inv.reference || inv.id,
      }),
      true,
    );
  } else {
    printDocument(node);
  }
}

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

export const Route = createFileRoute("/invoices/tracking")({
  component: InvoicesTrackingPage,
});

function InvoicesTrackingPage() {
  useInventory();
  const [q, setQ] = useState("");
  const [type, setType] = useState<TrackKind>("all");
  const [status, setStatus] = useState<Invoice["status"] | "all">("all");
  const [partyId, setPartyId] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<Invoice | null>(null);
  const [historyInv, setHistoryInv] = useState<Invoice | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [toDelete, setToDelete] = useState<Invoice | null>(null);

  const invoiceTypeFilter: Invoice["type"] | undefined =
    type === "entry" || type === "sale" ? type : undefined;

  const filter: InvoiceFilter = useMemo(() => {
    const f: InvoiceFilter = {};
    if (q.trim()) f.search = q.trim();
    if (invoiceTypeFilter) f.type = invoiceTypeFilter;
    if (status !== "all") f.status = status;
    if (partyId !== "all") f.partyId = partyId;
    if (from) f.fromDate = from;
    if (to) f.toDate = to;
    f.page = page;
    f.limit = pageSize;
    return f;
  }, [q, invoiceTypeFilter, status, partyId, from, to, page, pageSize]);

  const { data, isLoading, error } = useInvoicesList(
    type === "return" || type === "print_send" || type === "print_receive"
      ? { ...filter, limit: 1 }
      : filter,
  );
  const invoices = useMemo(() => {
    if (type === "return" || type === "print_send" || type === "print_receive") return [];
    return data?.data ?? [];
  }, [data, type]);
  const { data: returnsData } = useReturnsList({ limit: 500 });
  const { data: printJobs = [] } = usePrintJobs();
  const allParties = [...customers, ...suppliers];
  const { data: vouchersData } = useVouchersList();
  const allVouchers = vouchersData?.data ?? [];

  const cancelInvoice = useCancelInvoice();

  const extraRows: TrackRow[] = useMemo(() => {
    const rows: TrackRow[] = [];
    const qLower = q.trim().toLowerCase();
    if (type === "all" || type === "return") {
      for (const r of returnsData?.data ?? []) {
        if (status === "active" && r.status !== "active") continue;
        if (status === "cancelled" && r.status !== "cancelled") continue;
        if (partyId !== "all" && r.partyId !== partyId) continue;
        if (from && r.date < from) continue;
        if (to && r.date > to) continue;
        const party =
          r.kind === "entry"
            ? suppliers.find((p) => p.id === r.partyId)
            : customers.find((p) => p.id === r.partyId);
        const label = r.kind === "entry" ? "مرتجع دخول" : "مرتجع بيع";
        if (qLower && !`${r.number} ${party?.name ?? ""} ${label}`.toLowerCase().includes(qLower)) {
          continue;
        }
        const totalVal = r.lines.reduce((s, l) => s + l.quantityKg * l.pricePerKg, 0);
        rows.push({
          id: `ret-${r.id}`,
          kind: "return",
          number: r.number,
          date: r.date,
          partyName: party?.name ?? "—",
          totalLabel: formatAmount(totalVal, r.currency as never),
          statusLabel: r.status === "active" ? "نشطة" : "ملغاة",
          href: "/returns",
        });
      }
    }
    if (type === "all" || type === "print_send" || type === "print_receive") {
      for (const j of printJobs) {
        const isRecv = j.status === "received";
        if (type === "print_send" && isRecv) continue;
        if (type === "print_receive" && !isRecv) continue;
        if (qLower && !`${j.number} ${j.pressName ?? ""}`.toLowerCase().includes(qLower)) continue;
        rows.push({
          id: `print-${j.id}`,
          kind: isRecv ? "print_receive" : "print_send",
          number: j.number,
          date: j.sentDate,
          partyName: j.pressName || "مطبعة",
          totalLabel: `${j.sentKg} كغ`,
          statusLabel: isRecv ? "مستلم" : "مرسل",
          href: isRecv ? "/invoices/print-receive/new" : "/invoices/print-send/new",
        });
      }
    }
    return rows;
  }, [returnsData, printJobs, type, status, partyId, from, to, q]);

  const invoiceTotal = useMemo(() => data?.total ?? 0, [data]);
  const total =
    type === "all"
      ? invoiceTotal + extraRows.length
      : type === "entry" || type === "sale"
        ? invoiceTotal
        : extraRows.length;

  useEffect(() => setPage(0), [q, type, status, partyId, from, to]);

  const handlePrintAll = () => {
    const docs = invoices.map((inv, i) => (
      <div key={inv.id}>
        {i > 0 && <PrintPageBreak />}
        <InvoicePrintDocument invoice={inv} />
      </div>
    ));
    printDocument(<>{docs}</>);
  };

  return (
    <AppShell
      title="تتبع الفواتير"
      subtitle="جميع فواتير الدخول والبيع والمرتجعات — اعرض واطبع بأي هوية موحّدة."
      actions={
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrintAll}
            disabled={invoices.length === 0}
          >
            <Printer className="ml-1 h-4 w-4" /> طباعة المفضلة ({invoices.length})
          </Button>
        </div>
      }
    >
      <style>{`
        @media print {
          .no-print, header, nav, aside { display: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
      <div className="print:hidden">
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
              <Select value={type} onValueChange={(v) => setType(v as TrackKind)}>
                <SelectTrigger className="!h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">الكل</SelectItem>
                  <SelectItem value="entry">فاتورة دخول</SelectItem>
                  <SelectItem value="sale">فاتورة بيع</SelectItem>
                  <SelectItem value="return">مرتجع</SelectItem>
                  <SelectItem value="print_send">إرسال مطبعة</SelectItem>
                  <SelectItem value="print_receive">استلام مطبعة</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">الحالة</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as Invoice["status"] | "all")}
              >
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
          title="سجل الفواتير"
          description={`عرض ${invoices.length + extraRows.length} مستنداً (فواتير + مرتجعات + مطبعة).`}
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
                    <th>الحالة</th>
                    <th className="text-left">عرض وطباعة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoices.map((inv) => {
                    const party = allParties.find((p) => p.id === inv.partyId);
                    const isCancelled = inv.status === "cancelled";
                    return (
                      <tr key={inv.id} className={isCancelled ? "bg-destructive/5" : ""}>
                        <td className="px-3 py-2 font-mono text-xs text-primary">{inv.number}</td>
                        <td className="px-3 py-2">{TYPE_LABEL[inv.type]}</td>
                        <td className="px-3 py-2">{party?.name ?? "—"}</td>
                        <td className="px-3 py-2 tabular-nums">{formatDateTime(inv.createdAt)}</td>
                        <td className="px-3 py-2 text-left tabular-nums">
                          {formatAmount(inv.total(), inv.currency)}
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
                          <div className="inline-flex flex-nowrap items-center justify-end gap-1 whitespace-nowrap">
                            <Button size="sm" variant="ghost" onClick={() => setPreview(inv)}>
                              <Eye className="ml-1 h-4 w-4" /> عرض
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setPreview(inv);
                                printInvoiceWithArchive(inv);
                              }}
                            >
                              <Printer className="ml-1 h-4 w-4" /> طباعة
                            </Button>
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
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setHistoryInv(inv)}
                              aria-label="سجل الفاتورة"
                              title="الخط الزمني للفاتورة (من سجل التدقيق)"
                            >
                              <History className="ml-1 h-4 w-4" /> السجل
                            </Button>
                            <Link
                              to={
                                inv.type === "entry" ? "/invoices/entry/new" : "/invoices/sale/new"
                              }
                              search={{ edit: inv.id }}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                            >
                              <Pencil className="h-3.5 w-3.5" /> تعديل
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {extraRows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 font-mono text-xs text-primary">{row.number}</td>
                      <td className="px-3 py-2">
                        {row.kind === "return"
                          ? "مرتجع"
                          : row.kind === "print_send"
                            ? "إرسال مطبعة"
                            : "استلام مطبعة"}
                      </td>
                      <td className="px-3 py-2">{row.partyName}</td>
                      <td className="px-3 py-2 tabular-nums">{row.date}</td>
                      <td className="px-3 py-2 text-left tabular-nums">{row.totalLabel}</td>
                      <td className="px-3 py-2">{row.statusLabel}</td>
                      <td className="px-3 py-2 text-left">
                        <Link
                          to={row.href}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:underline"
                        >
                          فتح
                        </Link>
                      </td>
                    </tr>
                  ))}
                  {invoices.length === 0 && extraRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-10 text-center text-muted-foreground">
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
      </div>

      {/* Preview dialog — printable with the same visual identity */}
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent
          dir="rtl"
          className="!max-w-3xl w-[calc(100vw-2rem)] overflow-y-auto max-h-[90vh]"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileStack className="h-5 w-5 text-primary" />
              معاينة الفاتورة
            </DialogTitle>
            <DialogDescription>
              عاين الفاتورة بالهوية البصرية للشركة ثم اطبعها مباشرة.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border p-3">
            {preview && <InvoicePrintView invoice={preview} />}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setPreview(null)}>
              إغلاق
            </Button>
            <Button className="gap-2" onClick={() => preview && printInvoiceWithArchive(preview)}>
              <Printer className="h-4 w-4" /> طباعة
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete (cancel) confirmation */}
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

      {/* Invoice audit timeline (tracking) */}
      <InvoiceTimelineDialog invoice={historyInv} onClose={() => setHistoryInv(null)} />
    </AppShell>
  );
}

/* ═══════════════ Invoice Audit Timeline (tracking feature) ═══════════════ */

type InvoiceSnapshot = {
  number?: string;
  date?: string;
  currency?: string;
  status?: string;
  discount?: number;
  tax?: number;
  total?: number;
  lines?: { rollId: string; quantityKg: number; pricePerKg: number; pieces?: number }[];
};

const ACTION_META: Record<string, { label: string; cls: string; Icon: typeof PencilLine }> = {
  create: { label: "إنشاء", cls: "bg-success/15 text-success", Icon: CheckCircle2 },
  update: { label: "تعديل", cls: "bg-primary/15 text-primary", Icon: PencilLine },
  cancel: { label: "إلغاء", cls: "bg-destructive/15 text-destructive", Icon: XCircle },
};

/** Human-readable field diffs between the before/after snapshots of an update. */
function snapshotDiffs(
  before: InvoiceSnapshot | null | undefined,
  after: InvoiceSnapshot | null | undefined,
): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  const num = (v: unknown) => (typeof v === "number" ? formatNumber(v) : String(v ?? "—"));
  const fields: [keyof InvoiceSnapshot, string][] = [
    ["date", "التاريخ"],
    ["currency", "العملة"],
    ["status", "الحالة"],
    ["discount", "الخصم"],
    ["tax", "الضريبة"],
    ["total", "الإجمالي"],
  ];
  for (const [key, label] of fields) {
    const b = before[key];
    const a = after[key];
    if (String(b ?? "") !== String(a ?? "")) out.push(`${label}: ${num(b)} ← ${num(a)}`);
  }
  const bl = before.lines ?? [];
  const al = after.lines ?? [];
  if (JSON.stringify(bl) !== JSON.stringify(al)) {
    out.push(`عدد البنود: ${bl.length} ← ${al.length}`);
    for (const aLine of al) {
      const bLine = bl.find((x) => x.rollId === aLine.rollId);
      if (!bLine) {
        out.push(`بند جديد: ${aLine.quantityKg} كغ × ${aLine.pricePerKg}`);
      } else {
        if (bLine.quantityKg !== aLine.quantityKg)
          out.push(`كمية بند: ${bLine.quantityKg} ← ${aLine.quantityKg} كغ`);
        if (bLine.pricePerKg !== aLine.pricePerKg)
          out.push(`سعر بند: ${bLine.pricePerKg} ← ${aLine.pricePerKg}`);
      }
    }
    for (const bLine of bl) {
      if (!al.find((x) => x.rollId === bLine.rollId))
        out.push(`بند محذوف (${bLine.quantityKg} كغ)`);
    }
  }
  return out;
}

function TimelineRow({ entry }: { entry: AuditLogDTO }) {
  const meta = ACTION_META[entry.action] ?? {
    label: entry.action,
    cls: "bg-secondary text-muted-foreground",
    Icon: ArrowLeftRight,
  };
  const diffs = snapshotDiffs(
    entry.beforeSnapshot as InvoiceSnapshot | null,
    entry.afterSnapshot as InvoiceSnapshot | null,
  );
  const Icon = meta.Icon;
  return (
    <li className="relative pr-8 pb-5 last:pb-0">
      {/* timeline rail */}
      <span
        className="absolute right-[11px] top-6 bottom-0 w-px bg-border last:hidden"
        aria-hidden
      />
      <span
        className={`absolute right-0 top-0 grid h-6 w-6 place-items-center rounded-full ${meta.cls}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-xs font-bold text-foreground">{meta.label}</span>
        <span className="text-[11px] font-medium text-muted-foreground">
          {entry.actorName || (entry.actorId ? `مستخدم ${entry.actorId.slice(0, 8)}` : "غير معروف")}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums" dir="ltr">
          {formatDateTime(entry.createdAt)}
        </span>
      </div>
      {entry.detail && <div className="mt-0.5 text-xs text-muted-foreground">{entry.detail}</div>}
      {diffs.length > 0 && (
        <details className="mt-1.5 rounded-md border border-border bg-secondary/30 px-2.5 py-1.5">
          <summary className="cursor-pointer text-[11px] font-semibold text-primary">
            عرض التغييرات ({diffs.length})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {diffs.map((d, i) => (
              <li
                key={i}
                className="flex items-center gap-1.5 text-[11px] text-foreground tabular-nums"
              >
                {d.includes("←") ? (
                  <ArrowLeftRight className="h-3 w-3 text-muted-foreground" />
                ) : d.includes("جديد") ? (
                  <Plus className="h-3 w-3 text-success" />
                ) : d.includes("محذوف") ? (
                  <Minus className="h-3 w-3 text-destructive" />
                ) : (
                  <ArrowLeftRight className="h-3 w-3 text-muted-foreground" />
                )}
                <span dir="auto">{d}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Full audit timeline dialog for one invoice — the heart of invoice tracking. */
function InvoiceTimelineDialog({
  invoice,
  onClose,
}: {
  invoice: Invoice | null;
  onClose: () => void;
}) {
  const { data: logs, isLoading, error } = useInvoiceAudit(invoice?.id);
  const party = [...customers, ...suppliers].find((p) => p.id === invoice?.partyId);
  return (
    <Dialog open={invoice !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        dir="rtl"
        className="!max-w-2xl w-[calc(100vw-2rem)] overflow-y-auto max-h-[90vh]"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            الخط الزمني للفاتورة {invoice?.number}
          </DialogTitle>
          <DialogDescription>
            السجل الكامل من قاعدة بيانات التدقيق — من أُنشئت، كل تعديل ومَن عدّله، وحتى الإلغاء.
          </DialogDescription>
        </DialogHeader>

        {invoice && (
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-secondary/30 p-3 text-xs md:grid-cols-4">
            <div>
              <div className="text-[10px] text-muted-foreground">الرقم</div>
              <div className="font-bold text-primary" dir="ltr">
                {invoice.number}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground">النوع</div>
              <div className="font-semibold">{TYPE_LABEL[invoice.type]}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground">الطرف</div>
              <div className="font-semibold truncate">{party?.name ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground">الحالة</div>
              <div
                className={`font-semibold ${invoice.status === "cancelled" ? "text-destructive" : "text-success"}`}
              >
                {STATUS_LABEL[invoice.status as Invoice["status"]]}
              </div>
            </div>
          </div>
        )}

        {isLoading && (
          <div className="py-8 text-center text-sm text-muted-foreground">جاري تحميل السجل…</div>
        )}
        {error && (
          <div className="py-6 text-center text-sm text-destructive">تعذّر تحميل سجل التدقيق.</div>
        )}
        {!isLoading && !error && (logs ?? []).length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            لا توجد أحداث مسجلة لهذه الفاتورة.
          </div>
        )}
        {!isLoading && !error && (logs ?? []).length > 0 && (
          <ul className="mt-1 max-h-[50vh] overflow-y-auto pl-1">
            {(logs ?? []).map((entry) => (
              <TimelineRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            إغلاق
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
