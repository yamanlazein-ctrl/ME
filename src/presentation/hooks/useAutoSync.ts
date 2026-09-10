import { useEffect, useRef } from "react";
import { useConnectivity, type ConnectivityStatus } from "@/presentation/hooks/useConnectivity";
import { hasStoredSession } from "@/infrastructure/auth/TokenProvider";
import { runSyncNow } from "@/lib/sync-engine";

/**
 * When connectivity flips to online (and a session exists), trigger a local
 * outbox push to the central hub. No-op when CENTRAL_SYNC_URL is unset on
 * the backend (run returns skipped).
 */
export function useAutoSync() {
  const status = useConnectivity(15_000);
  const prev = useRef<ConnectivityStatus | null>(null);

  useEffect(() => {
    const previous = prev.current;
    prev.current = status;
    if (status !== "online") return;
    if (!hasStoredSession()) return;
    // Mount already-online, or transition offline → online.
    if (previous !== null && previous !== "offline") return;

    void runSyncNow().catch((err) => {
      console.warn("[sync] auto run skipped:", err);
    });
  }, [status]);
}
