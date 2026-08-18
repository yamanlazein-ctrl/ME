import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState, useCallback } from "react";
import {
  Download, Upload, Save, Archive, Database, FileStack,
  Loader2, CheckCircle2, AlertCircle, Clock, HardDrive,
} from "lucide-react";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { settings, logActivity } from "@/presentation/hooks/useSettings";

const ALLOWED_SETTING_KEYS = [
  "company", "currencies", "paymentMethods", "taxes", "units",
  "warehouses", "printing", "users", "activity", "companyId", "version",
] as const;

function validateBackup(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.version === "number" && d.version === 1 &&
    typeof d.exportedAt === "string" &&
    typeof d.settings === "object" && d.settings !== null && !Array.isArray(d.settings)
  );
}

export const Route = createFileRoute("/settings/backup")({ component: BackupPage });

function BackupPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [lastBackup, setLastBackup] = useState<string | null>(null);

  // ─── حالة النسخة الكاملة ───
  const [fullState, setFullState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [fullProgress, setFullProgress] = useState(0);
  const [fullError, setFullError] = useState<string | null>(null);
  const [lastFull, setLastFull] = useState<{ date: string; size: string; name: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancelFull = () => {
    abortRef.current?.abort();
    setFullState("idle");
    setFullProgress(0);
  };

  const downloadFullBackup = useCallback(async () => {
    setFullState("loading");
    setFullProgress(10);
    setFullError(null);
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const token = localStorage.getItem("accessToken");
      const tenantId = localStorage.getItem("tenantId");
      setFullProgress(30);

      const res = await fetch("/api/backup/full", {
        method: "POST",
        headers: {
          Authorization: token ? `Bearer ${token}` : "",
          "X-Tenant-Id": tenantId ?? "",
        },
        signal: abort.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "فشل الاتصال بالسيرفر" }));
        throw new Error(err.message || "فشل إنشاء النسخة");
      }
      setFullProgress(70);

      const blob = await res.blob();
      const size = blob.size;
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
      const fileName = `fabric-erp-full-backup-${timestamp}.zip`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setFullProgress(100);
      setFullState("success");
      const now = new Date();
      setLastFull({ date: now.toLocaleString("ar-SY"), size: formatBytes(size), name: fileName });
      setLastBackup(now.toLocaleString("ar"));
      logActivity("النسخ الاحتياطي", "تصدير نسخة كاملة", `حجم: ${formatBytes(size)}`);
      setTimeout(() => { setFullState("idle"); setFullProgress(0); }, 5000);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setFullState("idle");
      } else {
        setFullState("error");
        setFullError(err instanceof Error ? err.message : "خطأ غير معروف");
      }
      setFullProgress(0);
    }
  }, []);

  // ─── نسخة الإعدادات (القديمة) ───
  const exportSettings = () => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), settings };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `settings-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setLastBackup(new Date().toLocaleString("ar"));
    logActivity("النسخ الاحتياطي", "تصدير إعدادات");
  };
  const importSettings = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (!validateBackup(data)) { alert("ملف غير صالح."); return; }
      const src = data.settings as Record<string, unknown>;
      for (const key of ALLOWED_SETTING_KEYS) {
        if (key in src) (settings as Record<string, unknown>)[key] = src[key];
      }
      logActivity("النسخ الاحتياطي", "استعادة إعدادات", file.name);
      alert("تم استعادة الإعدادات بنجاح.");
    } catch { alert("فشل قراءة الملف."); }
  };

  return (
    <div className="space-y-6">
      {/* ─── النسخة الكاملة ─── */}
      <PageCard
        title="نسخة احتياطية كاملة (ZIP)"
        description="تصدير قاعدة البيانات + الملفات المرفوعة + الإعدادات في ملف ZIP واحد."
      >
        <div className="grid gap-4 md:grid-cols-2">
          {/* زر النسخ */}
          <div className="flex flex-col gap-3 rounded-xl border p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Archive className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="font-semibold">تصدير نسخة كاملة</div>
                <p className="text-xs text-muted-foreground">قاعدة البيانات + الملفات + الإعدادات</p>
              </div>
            </div>

            {fullState === "loading" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> جاري إنشاء النسخة…
                  </span>
                  <span className="font-medium">{fullProgress}%</span>
                </div>
                <Progress value={fullProgress} className="h-2" />
                <Button variant="ghost" size="sm" className="text-destructive" onClick={cancelFull}>
                  إلغاء
                </Button>
              </div>
            )}
            {fullState === "success" && (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                تم التنزيل بنجاح! تحقق من مجلد التنزيلات.
              </div>
            )}
            {fullState === "error" && (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {fullError || "فشل إنشاء النسخة. حاول مرة أخرى."}
              </div>
            )}
            {fullState === "idle" && (
              <Button onClick={downloadFullBackup} className="w-full gap-2">
                <Download className="h-4 w-4" /> تصدير نسخة كاملة
              </Button>
            )}
          </div>

          {/* معلومات */}
          <div className="flex flex-col gap-3 rounded-xl border p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <HardDrive className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <div className="font-semibold">معلومات آخر نسخة</div>
                <p className="text-xs text-muted-foreground">تفاصيل النسخة الاحتياطية الأخيرة</p>
              </div>
            </div>
            {lastFull ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> التاريخ:</span>
                  <span className="font-medium">{lastFull.date}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-1"><Database className="h-3 w-3" /> الحجم:</span>
                  <span className="font-medium">{lastFull.size}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground flex items-center gap-1"><FileStack className="h-3 w-3" /> الملف:</span>
                  <span className="font-mono text-xs">{lastFull.name}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">لا توجد نسخة احتياطية كاملة سابقة.</p>
            )}
          </div>
        </div>

        {/* شرح */}
        <div className="mt-4 rounded-lg bg-muted/50 p-4">
          <h4 className="mb-2 text-sm font-semibold flex items-center gap-2">
            <FileStack className="h-4 w-4" /> ما يشمله النسخ الاحتياطي الكامل:
          </h4>
          <ul className="space-y-1 text-sm text-muted-foreground">
            <li className="flex items-center gap-2"><Database className="h-3 w-3 text-primary" />
              <strong>قاعدة البيانات:</strong> جميع الجداول (فواتير، أطراف، مخزون، سندات، …)</li>
            <li className="flex items-center gap-2"><FileStack className="h-3 w-3 text-primary" />
              <strong>الملفات المرفوعة:</strong> صور، مستندات، ملفات مرفقة بالفواتير</li>
            <li className="flex items-center gap-2"><Save className="h-3 w-3 text-primary" />
              <strong>إعدادات النظام:</strong> العملات، الضرائب، المستخدمين، طباعة</li>
            <li className="flex items-center gap-2"><Archive className="h-3 w-3 text-primary" />
              <strong>ملف معلومات:</strong> metadata (تاريخ، إصدار، مستخدم)</li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            الملف يُحفظ بتنسيق ZIP. يمكن استعادته عبر سكربت restore.sh في المشروع.
          </p>
        </div>
      </PageCard>

      {/* ─── نسخة الإعدادات (JSON) ─── */}
      <PageCard
        title="نسخة إعدادات (JSON)"
        description="تصدير الإعدادات فقط كملف JSON — أسرع وأخف للمشاركة."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <button
            onClick={exportSettings}
            className="flex flex-col items-center gap-2 rounded-xl border p-6 text-center transition hover:border-primary hover:bg-primary/5"
          >
            <Download className="h-6 w-6 text-primary" />
            <div className="text-sm font-semibold">تصدير الإعدادات</div>
            <p className="text-xs text-muted-foreground">حفظ الإعدادات في ملف JSON.</p>
          </button>
          <button
            onClick={() => inputRef.current?.click()}
            className="flex flex-col items-center gap-2 rounded-xl border p-6 text-center transition hover:border-primary hover:bg-primary/5"
          >
            <Upload className="h-6 w-6 text-primary" />
            <div className="text-sm font-semibold">استيراد الإعدادات</div>
            <p className="text-xs text-muted-foreground">استعادة إعدادات النظام من ملف.</p>
          </button>
          <input ref={inputRef} type="file" accept="application/json" hidden
            onChange={(e) => e.target.files?.[0] && importSettings(e.target.files[0])} />
        </div>
        {lastBackup && (
          <p className="mt-3 text-xs text-muted-foreground">
            <Save className="inline h-3 w-3 ml-1" /> آخر تصدير: {lastBackup}
          </p>
        )}
      </PageCard>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
