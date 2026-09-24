import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnectivity, type ConnectivityStatus } from "@/presentation/hooks/useConnectivity";
import { hasStoredSession } from "@/infrastructure/auth/TokenProvider";
import { runSyncNow } from "@/lib/sync-engine";
import { refreshParties } from "@/presentation/hooks/useParties";
import { refreshInventory } from "@/presentation/hooks/useInventory";

/**
 * When connectivity flips to online (and a session exists), trigger a local
 * outbox push to the central hub. No-op when CENTRAL_SYNC_URL is unset on
 * the backend (run returns skipped).
 *
 * P7: a failed trigger used to warn once and never retry until the next
 * offline→online flap — a hub outage during reconnect meant the backlog sat
 * until the user toggled connectivity. Now each trigger gets a bounded
 * retry series (30s, 2m) with timer cleanup on unmount. Still fire-and-forget
 * by design: sync status is observed via /sync/status, not via this hook.
 */
const RETRY_DELAYS_MS = [30_000, 120_000];
const PERIODIC_SYNC_MS = 20_000;

export function useAutoSync() {
  const qc = useQueryClient();
  const status = useConnectivity(15_000);
  const prev = useRef<ConnectivityStatus | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Device gate: the hub refused pushes with SYNC_UNKNOWN_DEVICE. Retrying
  // cannot help — the device must register first. Surfaced as state so the
  // header can show a register-device badge instead of spinning silently.
  const [deviceGate, setDeviceGate] = useState(false);
  // Batch 4 / 4B: the gate now also refuses REVOKED devices and devices that
  // are not bound to the signed-in user. The reason is kept so the badge can
  // say what actually happened, and the local outbox is never touched — the
  // documents stay pending until an operator restores the device.
  const [deviceTrust, setDeviceTrust] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    const previous = prev.current;
    prev.current = status;
    if (status !== "online") return;
    if (!hasStoredSession()) return;
    // Mount already-online, or transition offline → online.
    if (previous !== null && previous !== "offline") return;

    let cancelled = false;
    const attempt = async (retriesLeft: number[], attemptNo: number): Promise<void> => {
      try {
        const result = await runSyncNow();
        if (result?.deviceGate) {
          // No retry series: the same push will 403 again until an operator
          // restores the device's authority (register / reinstate / bind user).
          setDeviceGate(true);
          setDeviceTrust(result.deviceTrust ?? null);
          console.warn("[sync] device refused by the hub — register it before syncing");
          return;
        }
        setDeviceGate(false);
        setDeviceTrust(null);
        // A concurrency skip is not a failure — another trigger owns the run.
        if (result?.pullError) {
          throw new Error(result.pullError);
        }
      } catch (err) {
        if (cancelled) return;
        const next = retriesLeft[0];
        if (next === undefined) {
          console.warn("[sync] auto run failed after retries:", err);
          return;
        }
        console.warn(`[sync] auto run attempt ${attemptNo} failed, retrying:`, err);
        const timer = setTimeout(() => {
          void attempt(retriesLeft.slice(1), attemptNo + 1);
        }, next);
        timers.current.push(timer);
      }
    };
    void attempt(RETRY_DELAYS_MS, 1);

    return () => {
      cancelled = true;
    };
  }, [status]);

  // Steady cadence while online: the reconnect trigger above only fires on an
  // offline→online flip, so without this a device that stays online never
  // pulls a peer's invoice until the next network blip. Each tick is one
  // push+pull round trip; a tick that finds nothing is a cheap no-op on the hub.
  useEffect(() => {
    if (status !== "online") return;
    const tick = async () => {
      // No "window hidden" skip: the desktop app is usually minimized while
      // people work in other programs, and peers still need its documents
      // (background timers are only throttled by WebView2, not stopped).
      if (!hasStoredSession()) return;
      try {
        const result = await runSyncNow();
        if (!result || result.skipped) return;
        setDeviceGate(Boolean(result.deviceGate));
        setDeviceTrust(result.deviceGate ? (result.deviceTrust ?? null) : null);
        const pulledSomething = (result.pull?.applied ?? 0) > 0 && (result.pull?.pulled ?? 0) > 0;
        if (pulledSomething) {
          // Peers changed documents here: every list/detail view must re-read,
          // including the two module-level caches that live outside react-query.
          void refreshParties();
          void refreshInventory();
          await qc.invalidateQueries();
        } else if ((result.activity ?? 0) > 0 || (result.rejected ?? 0) > 0) {
          await qc.invalidateQueries({ queryKey: ["notifications"] });
        }
      } catch (err) {
        console.warn("[sync] periodic run failed:", err);
      }
    };
    const id = setInterval(() => void tick(), PERIODIC_SYNC_MS);
    return () => clearInterval(id);
  }, [status, qc]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    },
    [],
  );

  return { deviceGate, deviceTrust };
}
