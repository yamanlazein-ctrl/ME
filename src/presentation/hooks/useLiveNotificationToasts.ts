import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useNotifications } from "@/presentation/hooks/useNotifications";

const MAX_BURST = 5;

/**
 * Pure core of the toast layer: which notifications are NEW since the last
 * look. The first call (seen === null) only seeds the set, so opening the app
 * never replays the backlog (the bell still lists it).
 */
export function pickFreshNotifications<T extends { id: string }>(
  seen: Set<string> | null,
  data: readonly T[],
): { seen: Set<string>; toShow: T[]; overflow: number } {
  if (seen === null) return { seen: new Set(data.map((n) => n.id)), toShow: [], overflow: 0 };
  const next = new Set(seen);
  const fresh = data.filter((n) => !next.has(n.id));
  for (const n of fresh) next.add(n.id);
  // The list is newest-first: show the newest MAX_BURST, oldest first so the
  // latest ends on top; summarize the rest (e.g. a long offline catch-up).
  const toShow = fresh.slice(0, MAX_BURST).reverse();
  return { seen: next, toShow, overflow: fresh.length - toShow.length };
}

/**
 * Pops a toast for every notification that ARRIVES while the app is open —
 * «أضاف محمد فاتورة مبيعات جديدة رقم #102», «المحاسب سجّل دخوله الآن».
 * Clicking «عرض» opens the document.
 */
export function useLiveNotificationToasts() {
  const { data } = useNotifications();
  const navigate = useNavigate();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!data) return;
    const { seen: next, toShow, overflow } = pickFreshNotifications(seen.current, data);
    seen.current = next;
    for (const n of toShow) {
      const path = n.to?.path;
      const show =
        n.severity === "critical"
          ? toast.error
          : n.severity === "warning"
            ? toast.warning
            : toast.info;
      show(n.title, {
        description: n.detail,
        duration: 8_000,
        action: path
          ? {
              label: "عرض",
              onClick: () => {
                void navigate({ to: path });
              },
            }
          : undefined,
      });
    }
    if (overflow > 0) {
      toast.info(`و${overflow} تنبيهات أخرى — افتح جرس التنبيهات`);
    }
  }, [data, navigate]);
}
