import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { container } from "@/infrastructure/container";
import {
  deleteCustomer,
  deleteSupplier,
  refreshParties,
} from "@/presentation/hooks/useParties";
import { invalidateFinancialViews } from "@/presentation/hooks/invalidateFinancialViews";
import { toast } from "sonner";

export type PartyLinkedCounts = {
  invoices: number;
  vouchers: number;
  returns: number;
  orders: number;
  ledger: number;
};

export type PartyLinkedDoc = {
  kind: "invoice" | "voucher" | "return" | "order" | "ledger";
  id: string;
  label: string;
  date?: string | null;
  number?: string | null;
  amount?: number | null;
  currency?: string | null;
};

export type PartyDeletionImpact = {
  partyId: string;
  partyName: string;
  kind: "customer" | "supplier";
  kindLabel: string;
  version: number;
  /** Exact counts — the preview arrays below are capped and never used for decisions. */
  counts: PartyLinkedCounts;
  invoices: PartyLinkedDoc[];
  vouchers: PartyLinkedDoc[];
  returns: PartyLinkedDoc[];
  orders: PartyLinkedDoc[];
  ledgerActiveCount: number;
  lastActivityDate: string | null;
  canDeleteDirectly: boolean;
  requiresCascade: boolean;
  summaryLines: string[];
  warning: string;
  /** Last 10 documents of the party (any kind, cancelled included), newest first. */
  recentActivity?: (PartyLinkedDoc & { status: string })[];
  /** Exact effect of the delete on the party balance and the cash box (server-computed). */
  accounting?: {
    balanceNow: PartyMoney[];
    balanceAfter: PartyMoney[];
    cashboxChange: PartyMoney[];
    affectsCashbox: boolean;
    affectsBalance: boolean;
  };
};

export type PartyMoney = { currency: string; amount: number };

/** The phrase the operator must type before the delete button enables. */
export const PARTY_DELETE_CONFIRM_PHRASE = "نعم، متأكد";

/** Accepts the phrase with either comma (، or ,) and surrounding spaces. */
export function isPartyDeleteConfirmed(typed: string): boolean {
  return typed.trim().replace(/\s+/g, " ").replace(/,/g, "،") === PARTY_DELETE_CONFIRM_PHRASE;
}

const fmtMoney = (m: PartyMoney) =>
  `${m.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${m.currency}`;

type LinkedKind = "invoice" | "voucher" | "return" | "order";
type LinkedPage = { kind: LinkedKind; items: PartyLinkedDoc[]; total: number; nextCursor: string | null };

const PAGE_SIZE = 25;

const TABS: { kind: LinkedKind; label: string; countKey: keyof PartyLinkedCounts }[] = [
  { kind: "invoice", label: "الفواتير", countKey: "invoices" },
  { kind: "voucher", label: "السندات", countKey: "vouchers" },
  { kind: "return", label: "المرتجعات", countKey: "returns" },
  { kind: "order", label: "الطلبيات", countKey: "orders" },
];

async function fetchImpact(kind: "customer" | "supplier", id: string): Promise<PartyDeletionImpact> {
  const path = kind === "customer" ? "customers" : "suppliers";
  const res = await container.http.get<PartyDeletionImpact>(`/api/${path}/${id}/deletion-impact`);
  return res.data;
}

async function fetchLinkedDocs(
  kind: "customer" | "supplier",
  id: string,
  params: { kind: LinkedKind; cursor?: string | null; q?: string },
): Promise<LinkedPage> {
  const path = kind === "customer" ? "customers" : "suppliers";
  const query: Record<string, string> = { kind: params.kind, limit: String(PAGE_SIZE) };
  if (params.cursor) query.cursor = params.cursor;
  if (params.q) query.q = params.q;
  const res = await container.http.get<LinkedPage>(`/api/${path}/${id}/linked-docs`, {
    params: query,
  });
  return res.data;
}

export function PartyDeleteDialog({
  kind,
  partyId,
  partyName,
  open,
  onOpenChange,
  onDeleted,
}: {
  kind: "customer" | "supplier";
  partyId: string | null;
  partyName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired only after a successful delete (the detail page navigates away). */
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<LinkedKind>("invoice");
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  // Cursor stack: index 0 is the first page, so "previous" is a pop. A keyset
  // cursor cannot be inverted, and the stack keeps back-navigation exact.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [confirmText, setConfirmText] = useState("");

  const impact = useQuery({
    queryKey: ["party-deletion-impact", kind, partyId],
    queryFn: () => fetchImpact(kind, partyId!),
    enabled: open && Boolean(partyId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);

  // Any change of target, tab or filter restarts at the first page.
  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [partyId, kind, tab, search, open]);

  // A new target or a re-opened dialog always starts unconfirmed.
  useEffect(() => {
    setConfirmText("");
  }, [partyId, open]);

  const counts = impact.data?.counts;
  const linkedTotal = counts ? counts.invoices + counts.vouchers + counts.returns + counts.orders : 0;
  const canBrowse = linkedTotal > 0;

  const docs = useQuery({
    queryKey: ["party-linked-docs", kind, partyId, tab, search, pageIndex],
    queryFn: () =>
      fetchLinkedDocs(kind, partyId!, { kind: tab, cursor: cursors[pageIndex], q: search || undefined }),
    enabled: open && Boolean(partyId) && canBrowse,
    staleTime: 0,
    retry: false,
  });

  const del = useMutation({
    mutationFn: async () => {
      if (!partyId) throw new Error("السجل غير محدد");
      if (!isPartyDeleteConfirmed(confirmText)) throw new Error(`اكتب «${PARTY_DELETE_CONFIRM_PHRASE}» للتأكيد`);
      const sheet = impact.data;
      if (!sheet || typeof sheet.version !== "number") {
        throw new Error("حدّث معاينة الحذف ثم أعد المحاولة");
      }
      // Always take the cascade path when the sheet says so; otherwise soft-
      // cancel only. Pass the sheet's version — never re-default to 1.
      const cascade = Boolean(sheet.requiresCascade);
      if (kind === "supplier") await deleteSupplier(partyId, cascade, sheet.version);
      else await deleteCustomer(partyId, cascade, sheet.version);
    },
    onSuccess: () => {
      invalidateFinancialViews(qc, { refetchDashboard: true });
      void refreshParties();
      onOpenChange(false);
      onDeleted?.();
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "فشل الحذف");
    },
  });

  const data = impact.data;
  const label = kind === "supplier" ? "المورد" : "العميل";
  // Block confirm when returns/orders must be cleared first. Cascade of
  // invoices/vouchers alone stays allowed.
  const confirmBlocked = Boolean(data && (data.counts.returns > 0 || data.counts.orders > 0));
  const confirmed = isPartyDeleteConfirmed(confirmText);
  const acct = data?.accounting;
  const page = docs.data;
  const visibleTabs = useMemo(() => TABS.filter((t) => (counts?.[t.countKey] ?? 0) > 0), [counts]);
  // `total` is exact, so the last page is known without an extra request: a
  // keyset cursor cannot say "this was the last one" on a page that exactly
  // fills the limit.
  const hasNextPage = Boolean(page?.nextCursor) && (pageIndex + 1) * PAGE_SIZE < (page?.total ?? 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            حذف {label}
            {partyName ? ` «${partyName}»` : ""}
          </DialogTitle>
          <DialogDescription>
            يُعرض كل ما يرتبط بهذا السجل قبل التأكيد — فواتير وسندات ومرتجعات وطلبيات. كل المستندات
            متاحة للمراجعة: ابحث وتصفّح، ولا يُحذف شيء لم تقرأه.
          </DialogDescription>
        </DialogHeader>

        {impact.isLoading && (
          <p className="text-sm text-muted-foreground">جاري فحص الارتباطات…</p>
        )}
        {impact.isError && (
          <p className="text-sm text-destructive">
            {impact.error instanceof Error ? impact.error.message : "تعذّر فحص الارتباطات"}
          </p>
        )}
        {data && (
          <div className="max-h-[60vh] space-y-3 overflow-y-auto text-sm">
            {data.summaryLines.length === 0 ? (
              <p className="text-muted-foreground">لا توجد فواتير أو سندات أو ارتباطات نشطة.</p>
            ) : (
              <>
                <p className="font-semibold text-foreground">
                  {label} {data.partyName} مرتبط ببيانات موجودة في النظام:
                </p>
                <ul className="list-disc space-y-1 pr-5">
                  {data.summaryLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            )}

            {canBrowse && (
              <div className="rounded-md border border-border">
                <div className="flex flex-wrap items-center gap-1 border-b border-border bg-secondary/40 px-2 py-1.5">
                  {visibleTabs.map((t) => (
                    <Button
                      key={t.kind}
                      type="button"
                      size="sm"
                      variant={tab === t.kind ? "default" : "ghost"}
                      onClick={() => setTab(t.kind)}
                    >
                      {t.label} ({counts?.[t.countKey] ?? 0})
                    </Button>
                  ))}
                  <Input
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    placeholder="بحث برقم المستند أو التاريخ أو المبلغ…"
                    className="ms-auto h-8 w-56"
                    aria-label="بحث في المستندات المرتبطة"
                  />
                </div>

                {docs.isError ? (
                  <p className="p-3 text-destructive">
                    {docs.error instanceof Error ? docs.error.message : "تعذّر تحميل المستندات"}
                  </p>
                ) : (
                  <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                    {docs.isLoading && <li className="p-3 text-muted-foreground">جاري التحميل…</li>}
                    {!docs.isLoading && (page?.items.length ?? 0) === 0 && (
                      <li className="p-3 text-muted-foreground">لا توجد نتائج مطابقة.</li>
                    )}
                    {page?.items.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="truncate">
                          {d.kind === "return" || d.kind === "order" ? (
                            <span className="text-destructive">{d.label} — يجب إلغاؤه أولاً</span>
                          ) : (
                            d.label
                          )}
                        </span>
                        {d.date && <span className="shrink-0 text-muted-foreground">{d.date}</span>}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
                  <span>
                    {search ? `نتائج البحث: ` : ""}
                    معروض {page?.items.length ?? 0} من {page?.total ?? 0}
                    {docs.isFetching && !docs.isLoading ? " — جاري التحميل…" : ""}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pageIndex === 0 || docs.isFetching}
                      onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
                    >
                      السابق
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!hasNextPage || docs.isFetching}
                      onClick={() => {
                        const next = page?.nextCursor;
                        if (!next) return;
                        setCursors((c) => [...c.slice(0, pageIndex + 1), next]);
                        setPageIndex((i) => i + 1);
                      }}
                    >
                      التالي
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {data.recentActivity && (
              <div className="rounded-md border border-border">
                <p className="border-b border-border bg-secondary/40 px-3 py-1.5 font-semibold">
                  آخر {data.recentActivity.length} حركات مرتبطة
                </p>
                {data.recentActivity.length === 0 ? (
                  <p className="p-3 text-muted-foreground">لا توجد أي حركات سابقة لهذا السجل.</p>
                ) : (
                  <ul className="divide-y divide-border" aria-label="آخر الحركات المرتبطة">
                    {data.recentActivity.map((d) => (
                      <li
                        key={`${d.kind}-${d.id}`}
                        className={`flex items-center justify-between gap-2 px-3 py-1.5 ${d.status === "cancelled" ? "text-muted-foreground line-through" : ""}`}
                      >
                        <span className="truncate">{d.label}</span>
                        {d.date && <span className="shrink-0 text-muted-foreground">{d.date}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {acct && (
              <div
                className={`space-y-1 rounded-md border px-3 py-2 ${
                  acct.affectsCashbox || acct.affectsBalance
                    ? "border-destructive/40 bg-destructive/10"
                    : "border-emerald-500/40 bg-emerald-500/10"
                }`}
                role="status"
              >
                <p className="font-semibold">
                  {acct.affectsCashbox
                    ? "⚠ الحذف سيغيّر رصيد الصندوق"
                    : "✓ الحذف لن يغيّر رصيد الصندوق"}
                </p>
                {acct.cashboxChange.map((m) => (
                  <p key={`cash-${m.currency}`}>
                    الصندوق ({m.currency}): {m.amount < 0 ? "ينقص" : "يزيد"} بمقدار {fmtMoney({ ...m, amount: Math.abs(m.amount) })}
                  </p>
                ))}
                <p className="font-semibold">
                  {acct.affectsBalance
                    ? `⚠ الحذف سيغيّر رصيد ${label} في الحسابات`
                    : `✓ الحذف لن يغيّر رصيد ${label} في الحسابات`}
                </p>
                {acct.balanceNow.map((m, i) => (
                  <p key={`bal-${m.currency}`}>
                    رصيد {label} ({m.currency}): {fmtMoney(m)}
                    {acct.affectsBalance ? ` ← بعد الحذف: ${fmtMoney(acct.balanceAfter[i] ?? m)}` : ""}
                  </p>
                ))}
              </div>
            )}

            <p
              className={`rounded-md border px-3 py-2 text-xs ${
                confirmBlocked
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100"
              }`}
            >
              {data.warning}
            </p>
          </div>
        )}

        {data && !confirmBlocked && (
          <label className="block space-y-1 text-sm">
            <span>
              للتأكيد اكتب <strong>«{PARTY_DELETE_CONFIRM_PHRASE}»</strong>
            </span>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={PARTY_DELETE_CONFIRM_PHRASE}
              aria-label="عبارة تأكيد الحذف"
              autoComplete="off"
            />
          </label>
        )}

        <DialogFooter className="flex-row-reverse gap-2">
          <Button
            variant="destructive"
            disabled={!data || del.isPending || impact.isLoading || confirmBlocked || !confirmed}
            onClick={() => del.mutate()}
            title={
              confirmBlocked
                ? "ألغِ المرتجعات/الطلبيات أولاً"
                : !confirmed
                  ? `اكتب «${PARTY_DELETE_CONFIRM_PHRASE}» للتأكيد`
                  : undefined
            }
          >
            {del.isPending
              ? "جاري الحذف…"
              : confirmBlocked
                ? "تعذّر الحذف — ألغِ الارتباطات أولاً"
                : data?.requiresCascade
                  ? `نعم، احذف مع إلغاء ${counts?.invoices ?? 0} فاتورة و${counts?.vouchers ?? 0} سند`
                  : "نعم، احذف"}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={del.isPending}>
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
