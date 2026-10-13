import { useLiveRollStock } from "@/presentation/hooks/useInventory";
import { cn } from "@/lib/utils";
import { liveStockText, type LiveStockState } from "./liveStockText";

/**
 * Read-only reference: the real current stock of the exact selected roll (fabric + color + dye),
 * read live from the server. Not an input — the user cannot change it.
 */
export function LiveStockHint({
  rollId,
  className,
}: {
  rollId: string | undefined;
  className?: string;
}) {
  const q = useLiveRollStock(rollId);
  const enabled = Boolean(rollId) && !rollId!.startsWith("fabric:");
  const state: LiveStockState = !enabled
    ? { kind: "none" }
    : q.isPending
      ? { kind: "loading" }
      : q.isError || !q.data
        ? { kind: "unavailable" }
        : {
            kind: "ready",
            pieces: q.data.remainingPieces ?? null,
            kg: q.data.remainingKg,
          };
  const text = liveStockText(state);
  if (!text) return null;
  return (
    <div
      className={cn(
        "mt-1 text-[11px] tabular-nums text-muted-foreground/80",
        state.kind === "unavailable" && "text-destructive/80",
        className,
      )}
      aria-live="polite"
      data-testid="live-stock-hint"
    >
      {text}
    </div>
  );
}
