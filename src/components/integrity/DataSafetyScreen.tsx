import { useEffect, useState } from "react";
import { BaseHttpClient } from "@/infrastructure/http/BaseHttpClient";

type IntegrityStatus = {
  safeMode: boolean;
  reason: string | null;
  comparison: { severe: boolean; drops: Array<{ key: string; prev: number; now: number }> } | null;
  lastSuccessfulBackupAt: string | null;
  lastKnownCounts: Record<string, number> | null;
};

/**
 * REPAIR-023 — full-screen recovery when DATA_SAFE_MODE is active.
 */
export function DataSafetyScreen({ client }: { client: BaseHttpClient }) {
  const [status, setStatus] = useState<IntegrityStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client
      .get<IntegrityStatus>("/api/integrity/status")
      .then((r) => {
        if (!cancelled) setStatus(r.data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!status?.safeMode) return null;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.post("/api/integrity/accept-baseline", {});
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        background: "linear-gradient(160deg, #1a1510 0%, #3d2b1f 100%)",
        color: "#f5efe6",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "Georgia, 'Times New Roman', serif",
      }}
    >
      <div style={{ maxWidth: 560, width: "100%" }}>
        <h1 style={{ fontSize: 28, marginBottom: 8 }}>وضع أمان البيانات</h1>
        <p style={{ opacity: 0.85, lineHeight: 1.6 }}>
          تم اكتشاف انخفاض حاد في صفوف الأعمال مقارنة بآخر تحقق. الكتابة موقوفة حتى
          تُستعاد نسخة احتياطية أو يقبل المسؤول الوضع الحالي كخط أساس جديد.
        </p>
        {status.reason && (
          <p style={{ marginTop: 12 }}>
            السبب: <code>{status.reason}</code>
          </p>
        )}
        {status.comparison?.drops?.length ? (
          <ul style={{ marginTop: 16, lineHeight: 1.8 }}>
            {status.comparison.drops.map((d) => (
              <li key={d.key}>
                {d.key}: {d.prev} ← {d.now}
              </li>
            ))}
          </ul>
        ) : null}
        {status.lastSuccessfulBackupAt && (
          <p style={{ marginTop: 12, opacity: 0.8 }}>
            آخر نسخة احتياطية ناجحة: {status.lastSuccessfulBackupAt}
          </p>
        )}
        {error && <p style={{ color: "#f0a0a0" }}>{error}</p>}
        <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void accept()}
            style={{
              padding: "10px 18px",
              background: "#c4a574",
              border: 0,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            أفهم — اعتمد البيانات الحالية كخط أساس
          </button>
        </div>
      </div>
    </div>
  );
}
