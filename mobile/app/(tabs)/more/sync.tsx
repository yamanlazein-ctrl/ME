import { useEffect, useState } from "react";
import { getApp } from "../../../src/core/appRuntime";
import { useSyncStatus } from "../../../src/hooks/useSyncStatus";
import { SyncStatusView } from "../../../src/ui/SyncStatusView";

export default function SyncScreen() {
  const status = useSyncStatus();
  const [pending, setPending] = useState(0);
  useEffect(() => {
    void getApp().then(async (app) => {
      if (app.phone) {
        setPending(
          await app.phone.repos.syncOutboxRepo.countOutstanding(
            app.phone.identity.tenantId as never,
          ),
        );
      }
    });
  }, [status.lastRunAt]);
  return <SyncStatusView status={status} pending={pending} />;
}
