import { useEffect, useState } from "react";
import { ActivationScreen } from "./ActivationScreen";
import { isActivated } from "@/lib/license-state";

/**
 * Gate that runs the Setup Wizard before the app is usable.
 *
 * Two independent signals mean "already provisioned":
 *   1. Local activation state (this browser/desktop install activated a key).
 *   2. The backend reports the setup wizard as completed — needed because a
 *      fresh browser profile against an already-provisioned server has no
 *      local state and must NOT be sent through the wizard again.
 *
 * While the backend is being asked, nothing is rendered (a flash of the
 * wizard on a provisioned install would be worse than a blank frame). If the
 * status call fails the gate opens: a network hiccup must never lock an
 * operator out of a working install — license enforcement server-side is the
 * real protection, this gate is only the provisioning entry point.
 *
 * `VITE_ACTIVATION_BYPASS=1` skips the gate entirely for local UI work.
 */
const DEV_BYPASS = import.meta.env.VITE_ACTIVATION_BYPASS === "1";

function getApiBaseUrl(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  if (!raw || raw === "/api") return "";
  return raw.replace(/\/+$/, "");
}

export function ActivationGate({ children }: { children: React.ReactNode }) {
  const [activated, setActivated] = useState<boolean>(() => isActivated() || DEV_BYPASS);
  const [checking, setChecking] = useState<boolean>(() => !(isActivated() || DEV_BYPASS));

  useEffect(() => {
    if (!checking) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`${getApiBaseUrl()}/api/setup/status`);
        const data = (await r.json()) as { isCompleted?: boolean };
        if (!cancelled && data?.isCompleted) setActivated(true);
      } catch {
        // Backend unreachable — open the gate rather than trapping the user.
        if (!cancelled) setActivated(true);
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
