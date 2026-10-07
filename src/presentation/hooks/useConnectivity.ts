import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/api-base-url";

export type ConnectivityStatus = "online" | "offline";

/**
 * Is THIS device's local server answering? (top-bar indicator)
 *
 * Only the local API `/api/health/live` decides. Internet access is NOT part of
 * it: the local server, SQLite and every screen keep working without internet,
 * and cloud sync reports its own state separately (sync status badge). Using
 * `navigator.onLine` here used to show «لا يوجد اتصال بالخادم المحلي» the moment
 * the router went down, although the local server was fine.
 */
export function useConnectivity(pollMs = 15_000): ConnectivityStatus {
  const [status, setStatus] = useState<ConnectivityStatus>("online");

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/health/live`, {
          method: "GET",
          cache: "no-store",
          signal: AbortSignal.timeout(4_000),
        });
        if (!cancelled) setStatus(res.ok ? "online" : "offline");
      } catch {
        if (!cancelled) setStatus("offline");
      }
    };

    void probe();
    const timer = setInterval(() => void probe(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return status;
}
