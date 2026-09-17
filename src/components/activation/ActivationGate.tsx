import { useEffect, useState } from "react";
import { ActivationScreen } from "./ActivationScreen";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { clearLicense, isActivated } from "@/lib/license-state";

/**
 * Gate before AuthGate / app shell.
 *
 * N1 (V2): Local license markers are the source of truth for "already
 * activated on this device". Backend `isCompleted` alone must NOT skip the
 * license/invite screen — otherwise a provisioned DB opens straight to login
 * and never asks for the one-time key. After local activation succeeds once,
 * this gate stays open forever on this device (session restore is AuthGate).
 *
 * Soft network failure: if local markers exist, allow through; otherwise keep
 * the activation screen so a first-run cannot fall through to login.
 *
 * After a wiped/empty DB, `/api/setup/status` returns SETUP_STATUS_UNAVAILABLE —
 * stale local markers must not skip activation (otherwise AuthGate spins on
 * "جاري استعادة الجلسة…" with dead JWTs).
 *
 * `VITE_ACTIVATION_BYPASS=1` skips the gate entirely for local UI work.
 */
const DEV_BYPASS = import.meta.env.VITE_ACTIVATION_BYPASS === "1";

export function ActivationGate({ children }: { children: React.ReactNode }) {
  const [activated, setActivated] = useState<boolean>(() => DEV_BYPASS || isActivated());
  const [checking, setChecking] = useState<boolean>(() => !DEV_BYPASS);

  useEffect(() => {
    if (DEV_BYPASS) return;
    let cancelled = false;
    const ctrl = new AbortController();
    const kill = window.setTimeout(() => ctrl.abort(), 8_000);

    void (async () => {
      try {
        const localOk = isActivated();
        const base = getApiBaseUrl("");
        const url = `${base}/api/setup/status`.replace(/([^:]\/)\/+/g, "$1");
        const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { code?: string };
          if (
            r.status === 503 &&
            (body.code === "SETUP_STATUS_UNAVAILABLE" || body.code === "SETUP_REQUIRED")
          ) {
            clearLicense();
            if (!cancelled) setActivated(false);
            return;
          }
          if (!cancelled) setActivated(localOk);
          return;
        }
        const data = (await r.json()) as { isCompleted?: boolean };
        if (!cancelled) {
          if (data?.isCompleted === false) {
            clearLicense();
            setActivated(false);
          } else setActivated(localOk);
        }
      } catch {
        if (!cancelled) setActivated(isActivated());
      } finally {
        window.clearTimeout(kill);
        if (!cancelled) setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearTimeout(kill);
    };
  }, []);

  if (checking) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-background text-muted-foreground text-sm"
        dir="rtl"
        role="status"
        aria-live="polite"
      >
        جاري التحقق من التفعيل…
      </div>
    );
  }

  if (!activated) {
    return <ActivationScreen onActivated={() => setActivated(true)} />;
  }

  return <>{children}</>;
}
