import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { isTauri } from "@/infrastructure/tauri-bridge";

const IS_DESKTOP = import.meta.env.VITE_DESKTOP_DEPLOY === "true";

interface RegistryEntry {
  path: string;
  kind: string;
  createdAt: string;
  status: "VERIFIED" | "FAILED";
  sizeBytes: number | null;
  error: string | null;
  exists: boolean;
  lastRestoreTest: { at: string; ok: boolean; detail: string } | null;
}

const KIND_LABELS: Record<string, string> = {
  manual: "يدوية",
  automatic: "تلقائية",
  "pre-operation": "قبل عملية",
  "pre-migration": "قبل تحديث البيانات",
  "pre-restore": "قبل استعادة",
  "pre-update": "قبل تحديث البرنامج",
};

/**
 * Desktop only (T100): the backup registry (`backups.json`) with each backup's VERIFIED / FAILED
 * status and the weekly restore-test result. The web/cloud app renders nothing here.
 */
export function BackupRegistryStatus({ refreshKey = 0 }: { refreshKey?: number }) {
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = IS_DESKTOP && isTauri();

  useEffect(() => {
    if (!enabled) return;
    const token = getAccessToken();
    void fetch("/api/backup/registry", {
      headers: { Authorization: token ? `Bearer ${token}` : "" },
    })
      .then(async (r) => {
        if (!r.ok)
          throw new Error((await r.json().catch(() => ({}))).message || "تعذّر قراءة سجل النسخ");
        setEntries(((await r.json()) as { entries: RegistryEntry[] }).entries);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "تعذّر قراءة سجل النسخ"));
  }, [enabled, refreshKey]);

  if (!enabled) return null;

  return (
    <div className="mt-4 rounded-lg border p-4">
      <h4 className="mb-2 text-sm font-semibold">سجل النسخ الاحتياطية على هذا الجهاز</h4>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {entries && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">لا توجد نسخ بعد.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="space-y-1 text-xs">
          {entries.slice(0, 8).map((e) => (
            <li key={e.path} className="flex flex-wrap items-center gap-2">
              {e.status === "VERIFIED" ? (
                <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-700">
                  <CheckCircle2 className="h-3 w-3" /> VERIFIED
                </span>
              ) : (
                <span className="flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 font-semibold text-destructive">
                  <AlertCircle className="h-3 w-3" /> FAILED
                </span>
              )}
              <span>{KIND_LABELS[e.kind] ?? e.kind}</span>
              <span className="text-muted-foreground">
                {new Date(e.createdAt).toLocaleString("ar-SY")}
              </span>
              {!e.exists && <span className="text-amber-700">(الملف غير موجود)</span>}
              {e.lastRestoreTest && (
                <span className={e.lastRestoreTest.ok ? "text-emerald-700" : "text-destructive"}>
                  اختبار الاستعادة: {e.lastRestoreTest.ok ? "ناجح" : "فشل"}
                </span>
              )}
              {e.error && <span className="text-destructive">{e.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
