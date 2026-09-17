import { useEffect, useState } from "react";
import { setOfflineModeFlag } from "@/infrastructure/http/interceptors";
import { getApiBaseUrl } from "@/lib/api-base-url";

export type ConnectivityStatus = "online" | "offline";

/**
 * Real connectivity for the top-bar indicator.
 * Online = browser reports online AND local API `/api/health/live` responds OK.
 * Uses `getApiBaseUrl()` so desktop (SSR on :4173, API on :8080) does not probe
 * the wrong origin via a relative `/api/...` URL.
 */
export function useConnectivity(pollMs = 15_000): ConnectivityStatus {
  const [status, setStatus] = useState<ConnectivityStatus>(() =>
    typeof navigator !== "undefined" && navigator.onLine ? "online" : "offline",
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const apply = (next: ConnectivityStatus) => {
      if (cancelled) return;
      setStatus(next);
      setOfflineModeFlag(next === "offline");
    };

    const probe = async () => {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        apply("offline");
        return;
      }
      try {
        const ctrl = new AbortController();
        const kill = setTimeout(() => ctrl.abort(), 4_000);
        const res = await fetch(`${getApiBaseUrl()}/api/health/live`, {
          method: "GET",
          cache: "no-store",
          signal: ctrl.signal,
        });
        clearTimeout(kill);
        apply(res.ok ? "online" : "offline");
      } catch {
        apply("offline");
      }
    };

    const onOnline = () => {
      void probe();
    };
    const onOffline = () => {
      apply("offline");
    };

    void probe();
    timer = setInterval(() => void probe(), pollMs);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [pollMs]);

  return status;
}
