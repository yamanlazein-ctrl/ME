import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Download, Filter, Pencil, Plus, Search, Trash2, Truck, User } from "lucide-react";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
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
import { PartyFormDialog, type PartyKind, type SimpleParty } from "./PartyFormDialog";
import {
  addCustomer,
  addSupplier,
  customers,
  deleteCustomer,
  deleteSupplier,
  suppliers,
  updateCustomer,
  updateSupplier,
  useParties,
} from "@/presentation/hooks/useParties";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import { useInventory } from "@/presentation/hooks/useInventory";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { buildPartyStats } from "@/presentation/hooks/useLedger";
import { DataPagination } from "@/components/common/DataPagination";
import { BulkSelectToolbar } from "@/components/common/BulkSelectToolbar";
import { ConfirmBulkAction } from "@/components/common/ConfirmBulkAction";
import { Checkbox } from "@/components/ui/checkbox";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


const _nextFormId = 0;
function toMockPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) out[k] = void 0 as unknown;
    else out[k] = v;
  }
  return out;
}

export function PartyListPage({
  kind,
  title,
  description,
}: {
  kind: PartyKind;
  title: string;
  description: string;
}) {
  useInventory();
  useParties();
  const { data: invoicesData } = useInvoicesList();
  const invoices = invoicesData?.data ?? [];
  const { data: vouchersData } = useVouchersList();
  const vouchers = vouchersData?.data ?? [];
  const navigate = useNavigate();

  const list = kind === "supplier" ? suppliers : customers;
  const isSup = kind === "supplier";

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [credit, setCredit] = useState<"all" | "over" | "under">("all");
  const [form, setForm] = useState<{ open: boolean; editing?: SimpleParty }>({
    open: false,
  });
  const [toDelete, setToDelete] = useState<SimpleParty | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Record<string, SimpleParty>>({});
  const [bulkTarget, setBulkTarget] = useState<{ items: SimpleParty[] } | null>(null);

  const selectedList = Object.values(selected);
  const selectionCount = selectedList.length;

  const enterSelectMode = () => setSelectMode(true);
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected({});
  };
  const toggleSelect = (p: SimpleParty) => {
    setSelected((prev) => {
      const n = { ...prev };
      if (n[p.id]) delete n[p.id];
      else n[p.id] = p;
      return n;
    });
  };
  const selectAll = () => {
    setSelected((prev) => {
      const n = { ...prev };
      paged.forEach((p) => (n[p.id] = p));
      return n;
    });
  };
  const requestBulkDelete = () => {
    if (selectionCount === 0) return;
    setBulkTarget({ items: selectedList });
  };
  const confirmBulkDelete = async () => {
    if (!bulkTarget) return;
    for (const p of bulkTarget.items) {
      if (isSup) await deleteSupplier(p.id);
      else await deleteCustomer(p.id);
    }
    setBulkTarget(null);
    exitSelectMode();
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const arCollator = new Intl.Collator("ar", { sensitivity: "base", numeric: true });
    const result = list.filter((p) => {
      if (status !== "all" && (p.status ?? "active") !== status) return false;
      if (credit !== "all") {
        const s = buildPartyStats(p, kind, invoices, vouchers);
        const over = s.creditLimit > 0 && s.creditUsed > s.creditLimit;
        if (credit === "over" && !over) return false;
        if (credit === "under" && over) return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.companyName ?? "").toLowerCase().includes(q) ||
        (p.code ?? "").toLowerCase().includes(q) ||
        (p.phone ?? "").toLowerCase().includes(q) ||
        (p.email ?? "").toLowerCase().includes(q) ||
        (p.city ?? "").toLowerCase().includes(q)
      );
    });
    return [...result].sort((a, b) => {
      const byRecent = Number(new Date(b.createdAt)) - Number(new Date(a.createdAt));
      if (byRecent !== 0) return byRecent;
      return arCollator.compare(a.name ?? "", b.name ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status, credit, list.length, invoices, vouchers]);

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const paged = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  useEffect(() => setPage(0), [query, status, credit]);

  const openParty = (id: string) => {
    if (isSup) navigate({ to: "/suppliers/$id", params: { id } });
    else navigate({ to: "/customers/$id", params: { id } });
  };

  const exportCsv = () => {
    const rows = [
      [
        "الكود",
        "الاسم",
        "الشركة",
        "الهاتف",
        "المدينة",
        "عدد الفواتير",
        isSup ? "إجمالي المشتريات" : "إجمالي المبيعات",
        "المدفوع",
        "الرصيد",
        "حد الائتمان",
        "آخر عملية",
        "الحالة",
      ],
      ...filtered.map((p) => {
        const s = buildPartyStats(p, kind, invoices, vouchers);
        return [
          p.code ?? "",
          p.name,
          p.companyName ?? "",
          p.phone ?? "",
          p.city ?? "",
          String(s.invoicesCount),
          String(Math.round(s.totalAmount)),
          String(Math.round(s.totalPaid)),
          String(Math.round(s.remaining)),
          String(Math.round(s.creditLimit)),
          s.lastDate ?? "",
          (p.status ?? "active") === "active" ? "نشط" : "موقوف",
        ];
      }),
    ];
    const csv = rows.map((r) => r.map((c) => `"${c.replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind}s-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageCard
        title={title}
        description={description}
        noBodyPadding
        actions={
          <div className="flex items-center gap-2">
            <BulkSelectToolbar
              active={selectMode}
              count={selectionCount}
              idleLabel="حذف متعدد"
              actionLabel="حذف المحدد"
              canConfirm={selectionCount > 0}
              canSelectAll={paged.length > 0}
              onEnter={enterSelectMode}
              onExit={exitSelectMode}
              onSelectAll={selectAll}
              onAction={requestBulkDelete}
            />
            <Button
              onClick={() => setForm({ open: true })}
              className="h-10 gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              {isSup ? "إضافة مورد" : "إضافة عميل"}
            </Button>
          </div>
        }
      >
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-secondary/20 px-5 py-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ابحث بالكود، الاسم، الشركة، الهاتف، المدينة..."
              className="h-10 w-full rounded-lg border border-border bg-background pr-10 pl-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger className="!h-10 w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الحالات</SelectItem>
                <SelectItem value="active">نشط</SelectItem>
                <SelectItem value="inactive">موقوف</SelectItem>
              </SelectContent>
            </Select>
            <Select value={credit} onValueChange={(v) => setCredit(v as typeof credit)}>
              <SelectTrigger className="!h-10 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الحسابات</SelectItem>
                <SelectItem value="over">تجاوز حد الائتمان</SelectItem>
                <SelectItem value="under">ضمن حد الائتمان</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={exportCsv} className="h-10 gap-2">
            <Download className="h-4 w-4" /> تصدير
          </Button>
        </div>

        {/* Table */}
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[1200px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                {selectMode && <th className="w-10"></th>}
                <th className="w-24">الكود</th>
                <th className="min-w-[220px]">{isSup ? "اسم المورد" : "اسم العميل"}</th>
                <th className="w-32">الهاتف</th>
                <th className="w-24 text-center">الفواتير</th>
                <th className="w-36 text-left">{isSup ? "إجمالي المشتريات" : "إجمالي المبيعات"}</th>
                <th className="w-32 text-left">الرصيد</th>
                <th className="min-w-[160px] text-center">حد الائتمان</th>
                <th className="w-28">آخر عملية</th>
                <th className="w-20 text-center">الحالة</th>
                <th className="w-24 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={selectMode ? 11 : 10} className="px-4 py-16 text-center text-xs text-muted-foreground">
                    لا نتائج مطابقة.
                  </td>
                </tr>
              )}
              {paged.map((p) => {
                const s = buildPartyStats(p, kind, invoices, vouchers);
                const cur = currencySymbol(p.currency ?? "SYP");
                const active = (p.status ?? "active") === "active";
                const pct =
                  s.creditLimit > 0 ? Math.min(100, (s.creditUsed / s.creditLimit) * 100) : 0;
                const over = s.creditLimit > 0 && s.creditUsed > s.creditLimit;
                return (
                  <tr
                    key={p.id}
                    onClick={() => openParty(p.id)}
                    className="h-[60px] cursor-pointer align-middle hover:bg-secondary/40 [&>td]:px-3 [&>td]:py-2"
                  >
                    {selectMode && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={!!selected[p.id]}
                          onCheckedChange={() => toggleSelect(p)}
                          aria-label={`تحديد ${p.name}`}
                        />
                      </td>
                    )}
                    <td className="tabular-nums font-semibold text-primary">{p.code ?? "—"}</td>
                    <td>
                      <div className="flex items-center gap-3">
                        <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/15 text-primary">
                          {isSup ? <Truck className="h-4 w-4" /> : <User className="h-4 w-4" />}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-foreground">{p.name}</div>
                          {p.companyName && (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {p.companyName}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="tabular-nums text-muted-foreground">{p.phone ?? "—"}</td>
                    <td className="text-center tabular-nums text-foreground">{s.invoicesCount}</td>
                    <td className="text-left tabular-nums text-foreground">
                      {formatMoney(s.totalAmount)}{" "}
                      <span className="text-[10px] text-muted-foreground">{cur}</span>
                    </td>
                    <td
                      className={`text-left font-semibold tabular-nums ${
                        s.remaining > 0 ? "text-warning" : "text-success"
                      }`}
                    >
                      {formatMoney(s.remaining)}{" "}
                      <span className="text-[10px] opacity-70">{cur}</span>
                    </td>
                    <td>
                      {s.creditLimit > 0 ? (
                        <div className="flex flex-col items-center gap-1">
                          <div className="h-1.5 w-full max-w-[120px] overflow-hidden rounded bg-secondary">
                            <div
                              className={`h-full ${
                                over ? "bg-destructive" : pct > 80 ? "bg-warning" : "bg-primary"
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <div className="text-[10px] tabular-nums text-muted-foreground">
                            {formatMoney(s.creditUsed)} /{" "}
                            {formatMoney(s.creditLimit)}
                          </div>
                        </div>
                      ) : (
                        <div className="text-center text-[11px] text-muted-foreground">—</div>
                      )}
                    </td>
                    <td className="tabular-nums text-muted-foreground">{s.lastDate ?? "—"}</td>
                    <td className="text-center">
                      <span
                        className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                          active ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {active ? "نشط" : "موقوف"}
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={() => setForm({ open: true, editing: p })}
                          aria-label="تعديل"
                          className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setToDelete(p)}
                          aria-label="حذف"
                          className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <DataPagination
          total={total}
          page={safePage}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setPage(0);
          }}
        />
      </PageCard>

      <PartyFormDialog
        kind={kind}
        open={form.open}
        editing={form.editing}
        onClose={() => setForm({ open: false })}
        onSubmit={(patch) => {
          const mp = toMockPatch(patch as Record<string, unknown>);
          if (form.editing) {
            (isSup ? updateSupplier : updateCustomer)(
              form.editing.id as string,
              mp as Parameters<typeof updateSupplier>[1],
            );
          } else {
            (isSup ? addSupplier : addCustomer)(mp as Parameters<typeof addSupplier>[0]);
          }
          setForm({ open: false });
        }}
      />

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من حذف "{toDelete?.name}"؟ لا يمكن التراجع عن هذا الإجراء.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogAction
              onClick={() => {
                if (toDelete) (isSup ? deleteSupplier : deleteCustomer)(toDelete.id as string);
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

      <ConfirmBulkAction
        open={!!bulkTarget}
        title="تأكيد الحذف"
        description={`هل أنت متأكد من حذف ${bulkTarget?.items.length ?? 0} ${isSup ? "مورد" : "عميل"}؟ لا يمكن التراجع عن هذا الإجراء.`}
        confirmLabel={`حذف ${bulkTarget?.items.length ?? 0} عنصر`}
        items={(bulkTarget?.items ?? []).map((p) => ({ key: p.id, name: p.name }))}
        onCancel={() => setBulkTarget(null)}
        onConfirm={() => void confirmBulkDelete()}
      />
    </>
  );
}
