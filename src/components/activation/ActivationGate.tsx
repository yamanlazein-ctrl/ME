import { useEffect, useState } from "react";
import { ActivationScreen } from "./ActivationScreen";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { isActivated } from "@/lib/license-state";

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
 * `VITE_ACTIVATION_BYPASS=1` skips the gate entirely for local UI work.
 */
const DEV_BYPASS = import.meta.env.VITE_ACTIVATION_BYPASS === "1";

export function ActivationGate({ children }: { children: React.ReactNode }) {
  const [activated, setActivated] = useState<boolean>(() => DEV_BYPASS || isActivated());
  const [checking, setChecking] = useState<boolean>(() => !DEV_BYPASS);

  useEffect(() => {
    if (!checking) return;
    let cancelled = false;
    void (async () => {
      try {
        const localOk = isActivated();
        const r = await fetch(`${getApiBaseUrl("")}/api/setup/status`);
        if (!r.ok) {
          if (!cancelled) setActivated(localOk);
          return;
        }
        const data = (await r.json()) as { isCompleted?: boolean };
        // Pass only when this device has completed the one-time activation.
        // Incomplete backend setup always stays on the wizard.
        if (!cancelled) {
          if (data?.isCompleted === false) setActivated(false);
          else setActivated(localOk);
        }
      } catch {
        if (!cancelled) setActivated(isActivated());
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checking]);

  if (checking) return null;

  if (!activated) {
    return <ActivationScreen onActivated={() => setActivated(true)} />;
  }

  return <>{children}</>;
}
