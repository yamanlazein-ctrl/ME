import { RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useSyncStatus, SYNC_HUB_KEY } from "@/presentation/hooks/useSyncStatus";
import { describeSyncProblem, useSyncRunState, refreshAllData, hubSync, ORDERED_WAITING, type PendingUnit } from "@/lib/sync-engine";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Proof that work actually leaves this device. Sync ran every 20s all along,
 * but nothing on screen said so — a backlog looked identical to a quiet
 * device. Pending units, last success, and a manual trigger.
 */
export function SyncStatusBar() {
  const qc = useQueryClient();
  const { data: hub } = useSyncStatus();
  const run = useSyncRunState();
  const [showPending, setShowPending] = useState(false);

  // Unpaired installs have no hub to talk to — the bar would only add noise.
  if (!hub?.url) return null;

  const pending = hub.pendingCount ?? 0;
  const lastOk = run.lastRunAt ?? hub.lastPullAt;
  const failed = run.lastResult?.failed ?? 0;
  const offline = hub.reachable === false;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px]",
        offline || failed > 0
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-border bg-card/60 text-muted-foreground",
      )}
    >
      {offline ? <WifiOff className="h-3.5 w-3.5" /> : <Wifi className="h-3.5 w-3.5" />}
      {pending > 0 ? (
        <button type="button" className="underline underline-offset-2" onClick={() => setShowPending(true)}>
          {pending} بانتظار الإرسال
        </button>
      ) : (
        <span>لا شيء بانتظار الإرسال</span>
      )}
      <PendingDialog open={showPending} onOpenChange={setShowPending} />
      <span className="opacity-70">·</span>
      <span>آخر مزامنة: {formatWhen(lastOk)}</span>
      {failed > 0 && (
        <>
          <span className="opacity-70">·</span>
          <span>{failed} بانتظار إعادة المحاولة</span>
        </>
      )}
      <button
        type="button"
        disabled={run.running}
        onClick={() => {
          // Sync, then re-read the screen: it must show what was just received.
          void refreshAllData()
            .then((r) => {
              if (!r) return;
              if (r.failed > 0) toast.warning(`${r.failed} عمليات لم تُرسل بعد — ستُعاد المحاولة تلقائياً.`);
              else toast.success("تمت المزامنة");
            })
            .catch((e: Error) => toast.error(describeSyncProblem(e.message) ?? "تعذّرت المزامنة — ستُعاد المحاولة تلقائياً."))
            .finally(() => qc.invalidateQueries({ queryKey: SYNC_HUB_KEY }));
        }}
        className="ms-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-medium text-foreground transition hover:border-primary/40 hover:text-primary disabled:opacity-60"
      >
        <RefreshCw className={cn("h-3 w-3", run.running && "animate-spin")} />
        {run.running ? "جارٍ…" : "مزامنة الآن"}
      </button>
    </div>
  );
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `قبل ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `قبل ${hours} ساعة`;
  return new Date(iso).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
}

const ENTITY: Record<string, string> = {
  invoice: "فاتورة", voucher: "سند", return: "مرتجع", expense: "مصروف", order: "طلب",
  party: "عميل/مورد", fabric: "قماش", color: "لون", roll: "صبغة", ledger: "قيد",
  settlement: "تسوية", cashbox: "صندوق", settings: "إعدادات", company: "بيانات الشركة", print: "مطبعة",
};
const OPERATION: Record<string, string> = {
  create: "إنشاء", update: "تعديل", delete: "حذف", cancel: "إلغاء", adjust: "تعديل كمية",
  opening: "رصيد افتتاحي", close: "إقفال", movement: "حركة", send: "إرسال", receive: "استلام",
};

/** Each waiting operation in the operator's words: what, which document, since when, why. */
function PendingDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const q = useQuery({ queryKey: ["sync", "pending"], queryFn: () => hubSync.pending(), enabled: open, staleTime: 0 });
  const items = q.data?.items ?? [];
  const blocker = items.find((u) => u.errorDetail && u.errorDetail !== ORDERED_WAITING);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>العمليات بانتظار الإرسال</DialogTitle>
        </DialogHeader>
        {q.isPending && <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}
        {!q.isPending && items.length === 0 && <p className="text-sm text-muted-foreground">لا شيء بانتظار الإرسال.</p>}
        <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto text-sm">
          {items.map((u: PendingUnit) => (
            <li key={u.id} className="flex flex-col gap-0.5 py-2">
              <span className="font-medium">
                {OPERATION[u.operation] ?? u.operation} {ENTITY[u.entityType] ?? u.entityType}
                {u.ref ? `: ${u.ref}` : ""}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(u.createdAt).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" })}
                {u.beforePairing ? " · سُجّلت قبل ربط الجهاز" : ""}
              </span>
              {u.errorDetail === ORDERED_WAITING && blocker ? (
                <span className="text-xs text-amber-700">
                  تنتظر: {OPERATION[blocker.operation] ?? blocker.operation} {ENTITY[blocker.entityType] ?? blocker.entityType}
                  {blocker.ref ? ` ${blocker.ref}` : ""}
                </span>
              ) : u.errorDetail ? (
                <span className="text-xs text-destructive">{describeSyncProblem(u.errorDetail)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
