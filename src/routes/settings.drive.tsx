import { FormField } from "@/components/common/FormField";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CloudCog,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldAlert,
  Unplug,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  driveApi_,
  googleConfigure,
  googleConnectFinish,
  googleConnectStart,
  googleDisconnect,
  googleShellStatus,
  type DriveQueueJob,
} from "@/lib/drive-archive";
import { isTauri } from "@/infrastructure/tauri-bridge";
import { container } from "@/infrastructure/container";

export const Route = createFileRoute("/settings/drive")({ component: DriveSettingsPage });

const DRIVE_KEY = ["drive", "status"] as const;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function DriveSettingsPage() {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const shell = useQuery({
    queryKey: ["drive", "shell"],
    queryFn: googleShellStatus,
    enabled: isTauri(),
  });
  const status = useQuery({
    queryKey: DRIVE_KEY,
    queryFn: driveApi_.status,
    refetchInterval: 15_000,
  });
  const failed = useQuery({
    queryKey: ["drive", "failed"],
    queryFn: () => driveApi_.queue("failed"),
    refetchInterval: 30_000,
  });
  const blocked = useQuery({
    queryKey: ["drive", "blocked"],
    queryFn: () => driveApi_.queue("blocked"),
    refetchInterval: 30_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: DRIVE_KEY });
    void qc.invalidateQueries({ queryKey: ["drive"] });
  };

  const configure = useMutation({
    mutationFn: () => googleConfigure(clientId.trim(), clientSecret),
    onSuccess: () => {
      toast.success("تم حفظ معرّف العميل");
      setClientId("");
      setClientSecret("");
      invalidate();
      void qc.invalidateQueries({ queryKey: ["drive", "shell"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const connect = useMutation({
    mutationFn: async () => {
      await googleConnectStart(); // the shell opens the consent page in the system browser
      return googleConnectFinish();
    },
    onMutate: () => setConnecting(true),
    onSuccess: (s) => {
      toast.success(`تم الربط: ${s.email || "حساب Google"}`);
      invalidate();
      void qc.invalidateQueries({ queryKey: ["drive", "shell"] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setConnecting(false),
  });

  const disconnect = useMutation({
    mutationFn: googleDisconnect,
    onSuccess: () => {
      toast.success("تم فصل الحساب");
      invalidate();
      void qc.invalidateQueries({ queryKey: ["drive", "shell"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: driveApi_.test,
    onSuccess: (r) => toast.success(`الاتصال سليم: ${r.email ?? "Google Drive"}`),
    onError: (e: Error) => toast.error(e.message),
  });

  const syncNow = useMutation({
    mutationFn: driveApi_.syncNow,
    onSuccess: (r) => toast.success(`تمت جدولة ${r.queued} ملفًا${r.started ? " وبدأ الرفع" : ""}`),
    onError: (e: Error) => toast.error(e.message),
    onSettled: invalidate,
  });

  // D-07: the primary designation is the replicated `drive` settings section (synced like every
  // other section), so two devices can never both believe they are primary for long.
  const designate = useMutation({
    mutationFn: (enable: boolean) => {
      const cur = status.data;
      if (enable && !cur?.localDeviceId) throw new Error("لا توجد هوية جهاز على هذا التثبيت");
      return container.settings.api.updateSection("drive", {
        archiveEnabled: enable,
        coordinatorDeviceId: enable ? cur!.localDeviceId : (cur?.coordinatorDeviceId ?? null),
      });
    },
    onSuccess: (_r, enable) =>
      toast.success(enable ? "تم تفعيل الأرشفة على هذا الجهاز" : "تم إيقاف الأرشفة"),
    onError: (e: Error) => toast.error(e.message),
    onSettled: invalidate,
  });

  const retry = useMutation({
    mutationFn: (id: string) => driveApi_.retry(id),
    onSuccess: () => toast.success("أُعيدت الجدولة"),
    onError: (e: Error) => toast.error(e.message),
    onSettled: invalidate,
  });

  if (!isTauri()) {
    return (
      <PageCard title="أرشيف Google Drive">
        <div className="flex items-center gap-2 text-muted-foreground p-4">
          <ShieldAlert className="size-5" />
          متاح في تطبيق سطح المكتب فقط.
        </div>
      </PageCard>
    );
  }

  const shellData = shell.data;
  const st = status.data;
  const failedJobs: DriveQueueJob[] = [...(failed.data?.jobs ?? []), ...(blocked.data?.jobs ?? [])];

  return (
    <PageCard title="أرشيف Google Drive">
      <div className="space-y-6 p-4" dir="rtl">
        {/* Connection card */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <CloudCog className="size-5" />
            <h3 className="font-semibold">حساب Google</h3>
            {shellData?.connected ? (
              <span className="flex items-center gap-1 text-sm text-emerald-600">
                <CheckCircle2 className="size-4" /> {shellData.email || "متصل"}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">غير مرتبط</span>
            )}
          </div>

          {!shellData?.configured && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm text-muted-foreground">
                أدخل بيانات عميل OAuth من نوع «Desktop app» من Google Cloud Console. تُخزَّن على هذا
                الجهاز مشفّرة ولا تُعرض مرة أخرى.
              </p>
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <FormField label="معرّف العميل (Client ID)">
                  <Input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="1234567890-abc.apps.googleusercontent.com"
                    dir="ltr"
                    autoComplete="off"
                  />
                </FormField>
                <FormField label="سر العميل (Client secret) — إن وُجد">
                  <Input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="GOCSPX-…"
                    dir="ltr"
                    autoComplete="off"
                  />
                </FormField>
                <Button
                  onClick={() => configure.mutate()}
                  disabled={!clientId.trim() || configure.isPending}
                >
                  {configure.isPending ? <Loader2 className="size-4 animate-spin" /> : "حفظ"}
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {shellData?.connected ? (
              <>
                <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
                  {test.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <PlugZap className="size-4" />
                  )}
                  اختبار الاتصال
                </Button>
                <Button variant="destructive" onClick={() => setConfirmDisconnect(true)}>
                  <Unplug className="size-4" /> فصل الحساب
                </Button>
              </>
            ) : (
              <Button
                onClick={() => connect.mutate()}
                disabled={!shellData?.configured || connect.isPending || connecting}
              >
                {connecting || connect.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ExternalLink className="size-4" />
                )}
                {connecting ? "بانتظار إتمام التفويض في المتصفح…" : "ربط حساب Google"}
              </Button>
            )}
          </div>
          {connecting && (
            <p className="text-sm text-muted-foreground">
              أكمل التفويض في نافذة المتصفح التي فُتحت. تُحفظ بيانات الاعتماد مشفّرة على هذا الجهاز
              فقط، ولا نطلب كلمة مرور Google أبدًا.
            </p>
          )}
        </section>

        {/* Status card */}
        {st && (
          <section className="space-y-3 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <RefreshCw className="size-4" />
              <h3 className="font-semibold">حالة الأرشفة</h3>
            </div>
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              <li>
                هذا الجهاز:{" "}
                {st.isPrimaryDevice ? (
                  <span className="text-emerald-600">جهاز الأرشفة الأساسي</span>
                ) : (
                  <span className="text-muted-foreground">جهاز ثانوي (لا يرفع)</span>
                )}
              </li>
              <li>
                آخر رفع ناجح:{" "}
                {st.lastUpload
                  ? `${st.lastUpload.fileName} — ${fmtDate(st.lastUpload.uploadedAt)}`
                  : "لا شيء بعد"}
              </li>
              <li>
                قائمة الرفع: {st.queue.pending} بانتظار، {st.queue.done} مكتمل، {st.queue.failed}{" "}
                فاشل، {st.queue.blocked} معطّل
              </li>
              <li>
                آخر دورة:{" "}
                {st.lastRun
                  ? `${st.lastRun.kind} — ${st.lastRun.state} — ${fmtDate(st.lastRun.startedAt)}`
                  : "—"}
              </li>
            </ul>
            {st.isPrimaryDevice && shellData?.connected && (
              <Button onClick={() => syncNow.mutate()} disabled={syncNow.isPending} size="sm">
                {syncNow.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                مزامنة الآن
              </Button>
            )}
            {st.archiveEnabled && st.isPrimaryDevice ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => designate.mutate(false)}
                disabled={designate.isPending}
              >
                إيقاف الأرشفة
              </Button>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  {st.coordinatorDeviceId && !st.isPrimaryDevice
                    ? "الأرشفة مسندة إلى جهاز آخر؛ هذا الجهاز يتابع الحالة فقط. إسنادها إلى هذا الجهاز يوقف الرفع من الجهاز الآخر."
                    : "الأرشفة غير مفعّلة. فعّلها على جهاز واحد فقط — الجهاز الذي يرفع الأرشيف."}
                </p>
                <Button
                  size="sm"
                  onClick={() => designate.mutate(true)}
                  disabled={designate.isPending || !st.localDeviceId}
                >
                  تفعيل الأرشفة من هذا الجهاز
                </Button>
              </div>
            )}
          </section>
        )}

        {/* Failed / blocked jobs */}
        {failedJobs.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4 text-destructive" />
              <h3 className="font-semibold">ملفات فاشلة أو معطّلة ({failedJobs.length})</h3>
            </div>
            <ul className="space-y-1">
              {failedJobs.map((j) => (
                <li
                  key={j.id}
                  className="flex items-center justify-between rounded-md border p-2 text-sm"
                >
                  <span dir="ltr" className="truncate font-mono text-xs">
                    {j.fileName}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {j.status === "blocked"
                        ? j.lastError === "AUTH"
                          ? "يتطلب إعادة الربط"
                          : "متوقف — يحتاج إعادة يدوية"
                        : `محاولات: ${j.retryCount}`}
                    </span>
                    {(j.status === "failed" || j.status === "blocked") && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => retry.mutate(j.id)}
                        disabled={retry.isPending}
                      >
                        إعادة
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <ConfirmDialog
          open={confirmDisconnect}
          onOpenChange={setConfirmDisconnect}
          onConfirm={() => {
            disconnect.mutate();
            setConfirmDisconnect(false);
          }}
          title="فصل حساب Google؟"
          description="سيُحذف التفويض من هذا الجهاز ولن يُرفع أرشيف جديد حتى إعادة الربط. الملفات المرفوعة سابقًا تبقى في Drive."
        />
      </div>
    </PageCard>
  );
}
