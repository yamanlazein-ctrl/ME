import { RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useSyncStatus, SYNC_HUB_KEY } from "@/presentation/hooks/useSyncStatus";
import { useSyncRunState, runSyncNow } from "@/lib/sync-engine";
import { useQueryClient } from "@tanstack/react-query";
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
      <span>
        {pending > 0 ? `${pending} بانتظار الإرسال` : "لا شيء بانتظار الإرسال"}
      </span>
      <span className="opacity-70">·</span>
      <span>آخر مزامنة: {formatWhen(lastOk)}</span>
      {failed > 0 && (
        <>
          <span className="opacity-70">·</span>
          <span>{failed} عملية فشلت</span>
        </>
      )}
      <button
        type="button"
        disabled={run.running}
        onClick={() => {
          void runSyncNow()
            .then((r) => {
              if (!r) return;
              if (r.failed > 0) toast.error(`فشلت ${r.failed} عملية في المزامنة`);
              else toast.success("تمت المزامنة");
            })
            .catch((e: Error) => toast.error(e.message || "تعذّرت المزامنة"))
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
