// Live inputs of the sync chip: the outbox counts (through the phone core), the network state and the sync loop's halts.
import { useEffect, useState } from "react";
import NetInfo from "@react-native-community/netinfo";
import { getApp, onHubSignal } from "../core/appRuntime";
import { deriveSyncState, type SyncChipState } from "./syncState";

const POLL_MS = 3_000;

export function useSyncState(): SyncChipState {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [halted, setHalted] = useState(false);

  useEffect(() => {
    const unsubscribeNet = NetInfo.addEventListener((s) => setOnline(s.isConnected !== false));
    const unsubscribeSignal = onHubSignal((signal) => {
      if (signal.kind === "versionMismatch" || signal.kind === "revoked") setHalted(true);
    });
    let cancelled = false;
    const poll = async () => {
      try {
        const app = await getApp();
        if (!app.phone || cancelled) return;
        const tenantId = app.phone.identity.tenantId;
        setPending(await app.phone.repos.syncOutboxRepo.countOutstanding(tenantId as never));
        const byStatus = await app.phone.repos.syncOutboxRepo.countByStatus(tenantId as never);
        setRejected(Number(byStatus.rejected ?? 0));
      } catch {
        // the chip keeps its last value
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribeNet();
      unsubscribeSignal();
    };
  }, []);

  return deriveSyncState({ online, pending, attention: halted || rejected > 0 });
}
