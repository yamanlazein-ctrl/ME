import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CloudCog,
  GitMerge,
  Loader2,
  PlugZap,
  RefreshCw,
  ShieldAlert,
  Unplug,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useCurrentUser } from "@/presentation/hooks/useAuth";
import {
  hubSync,
  runSyncNow,
  useSyncRunState,
  type HubState,
  type HubTestResult,
} from "@/lib/sync-engine";
import { isTauri } from "@/infrastructure/tauri-bridge";
import { FactoryResetCard } from "@/components/settings/FactoryResetCard";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/settings/sync")({ component: SyncSettingsPage });

const HUB_KEY = ["sync", "hub"] as const;

type Indicator = "unpaired" | "online" | "offline" | "syncing";

const INDICATOR: Record<Indicator, { label: string; dot: string; text: string }> = {
  unpaired: { label: "غير مربوط", dot: "bg-muted-foreground", text: "text-muted-foreground" },
  online: { label: "متصل", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  offline: { label: "غير متصل", dot: "bg-destructive", text: "text-destructive" },
  syncing: {
    label: "جاري المزامنة",
    dot: "bg-amber-500 animate-pulse",
    text: "text-amber-600 dark:text-amber-400",
  },
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ar", { dateStyle: "short", timeStyle: "medium" });
  } catch {
    return iso;
  }
}

function SyncSettingsPage() {
  const { data: me } = useCurrentUser();
  if (!me || me.role !== "admin") {
    return (
      <PageCard title="الوصول مرفوض" description="إعدادات المزامنة متاحة لمدير النظام فقط.">
        <div className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <ShieldAlert className="h-5 w-5" />
          <span>ليس لديك صلاحية لإدارة ربط الجهاز بالمركز.</span>
        </div>
      </PageCard>
    );
  }
  return <SyncSettingsAdmin />;
}

function SyncSettingsAdmin() {
  const qc = useQueryClient();
  const run = useSyncRunState();
  const hub = useQuery({
    queryKey: HUB_KEY,
    queryFn: () => hubSync.state(),
    refetchInterval: 10_000,
  });

  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [test, setTest] = useState<HubTestResult | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const state: HubState | undefined = hub.data;
  const effectiveUrl = url.trim() || state?.url || "";

  const indicator: Indicator = !state?.url
    ? "unpaired"
    : run.running
      ? "syncing"
      : state.reachable === false
        ? "offline"
        : "online";

  const testMut = useMutation({
    mutationFn: () => hubSync.test(effectiveUrl || undefined),
    onSuccess: (r) => setTest(r),
    onError: (e: Error) =>
      setTest({
        url: effectiveUrl,
        reachable: false,
        latencyMs: null,
        setupCompleted: null,
        error: e.message,
      }),
  });

  const connectMut = useMutation({
    mutationFn: () => hubSync.connect({ url: effectiveUrl, email: email.trim(), password }),
    onSuccess: async (r) => {
      setPassword("");
      toast.success("تم ربط الجهاز بالمركز", {
        description: r.cursorReset ? "مركز جديد — ستُسحب كل العمليات من البداية." : undefined,
      });
      if (r.deviceWarning) toast.warning(r.deviceWarning, { duration: 10_000 });
      await qc.invalidateQueries({ queryKey: HUB_KEY });
      void syncNow();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const disconnectMut = useMutation({
    mutationFn: () => hubSync.disconnect(),
    onSuccess: async () => {
      setTest(null);
      toast.success("أُلغي ربط المركز — العمل يبقى محلياً");
      await qc.invalidateQueries({ queryKey: HUB_KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function syncNow() {
    try {
      const r = await runSyncNow();
      if (!r) return;
      if (r.skipped) {
        if (r.reason && r.reason !== "sync already running") toast.info(r.reason);
        return;
      }
      if (r.deviceGate) {
        toast.error(r.deviceTrust?.message ?? "المركز رفض هذا الجهاز — أعد الربط");
      } else if (r.pullError) {
        toast.error(`تم الدفع لكن فشل السحب: ${r.pullError}`);
      } else {
        toast.success(
          `مزامنة: أُرسل ${r.pushed} · سُحب ${r.pull?.applied ?? 0}${r.rejected ? ` · رُفض ${r.rejected}` : ""}`,
        );
      }
      await qc.invalidateQueries();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشلت المزامنة");
    }
  }

  const onConnect = (e: FormEvent) => {
    e.preventDefault();
    if (!effectiveUrl || !email.trim() || !password) {
      toast.error("أدخل رابط المركز والبريد وكلمة المرور");
      return;
    }
    connectMut.mutate();
  };

  const ind = INDICATOR[indicator];
  const session = state?.session ?? null;
  const last = run.lastResult;

  return (
    <>
      <PageCard
        title="المزامنة السحابية"
        description="ربط هذا الجهاز بالخادم المركزي لتبادل الفواتير والعمليات مع باقي الأجهزة."
        actions={
          <span
            className={cn("inline-flex items-center gap-2 text-sm font-semibold", ind.text)}
            role="status"
            aria-live="polite"
          >
            <span className={cn("h-2.5 w-2.5 rounded-full", ind.dot)} aria-hidden />
            {ind.label}
          </span>
        }
      >
        {hub.isLoading ? (
          <p className="text-sm text-muted-foreground">جاري تحميل الحالة…</p>
        ) : hub.isError ? (
          <p className="text-sm text-destructive">{(hub.error as Error).message}</p>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Row label="رابط المركز" value={state?.url ?? "—"} mono />
            <Row
              label="حساب المركز"
              value={
                session
                  ? `${session.hubUserName ?? ""} ${session.hubUserEmail ? `(${session.hubUserEmail})` : ""}`.trim()
                  : "—"
              }
            />
            <Row label="معرّف الشركة في المركز" value={session?.hubTenantId ?? "—"} mono />
            <Row
              label="ترخيص المركز"
              value={
                session?.hubLicenseKey
                  ? `${session.hubLicenseKey}${session.hubLicenseStatus ? ` · ${session.hubLicenseStatus}` : ""}`
                  : "—"
              }
              mono
            />
            <Row
              label="تسجيل الجهاز في المركز"
              value={session?.hubDeviceId ? "مسجّل ✓" : state?.url ? "غير مسجّل — أعد الربط" : "—"}
            />
            <Row label="تاريخ الربط" value={fmt(session?.pairedAt)} />
            <Row label="عمليات بانتظار الإرسال" value={String(state?.pendingCount ?? 0)} />
            <Row label="آخر سحب من المركز" value={fmt(state?.lastPullAt)} />
            <Row
              label="آخر مزامنة"
              value={
                run.lastRunAt
                  ? `${fmt(run.lastRunAt)}${last && !last.skipped ? ` — أُرسل ${last.pushed}، سُحب ${last.pull?.applied ?? 0}` : ""}`
                  : "—"
              }
            />
            {run.lastError && <Row label="آخر خطأ" value={run.lastError} danger />}
          </dl>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void syncNow()}
            disabled={!state?.url || run.running}
          >
            {run.running ? (
              <Loader2 className="ml-1 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="ml-1 h-4 w-4" />
            )}
            مزامنة الآن
          </Button>
          <Button type="button" size="sm" variant="outline" asChild>
            <Link to="/sync/conflicts">
              <GitMerge className="ml-1 h-4 w-4" /> تعارضات المزامنة
            </Link>
          </Button>
          {state?.url && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirmDisconnect(true)}
              disabled={disconnectMut.isPending}
            >
              <Unplug className="ml-1 h-4 w-4" /> فصل المركز
            </Button>
          )}
        </div>
      </PageCard>

      <PageCard
        title={state?.url ? "إعادة الربط / تغيير المركز" : "ربط الجهاز بالمركز"}
        description="يُمسح الربط السابق، ثم يُسجَّل الدخول للمركز ويُسجَّل هذا الجهاز فيه ويُحفظ معرّف الشركة والترخيص تلقائياً."
      >
        <form onSubmit={onConnect} className="grid gap-4 md:max-w-xl">
          <div className="grid gap-1.5">
            <Label htmlFor="hub-url">رابط الخادم المركزي</Label>
            <Input
              id="hub-url"
              dir="ltr"
              type="url"
              placeholder={state?.url ?? "https://erp.example.com"}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setTest(null);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="hub-email">بريد حساب المركز</Label>
            <Input
              id="hub-email"
              dir="ltr"
              type="email"
              autoComplete="username"
              placeholder={session?.hubUserEmail ?? "admin@example.com"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="hub-password">كلمة مرور حساب المركز</Label>
            <Input
              id="hub-password"
              dir="ltr"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {test && (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                test.reachable && test.setupCompleted !== false
                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                  : "border-destructive/40 bg-destructive/5 text-destructive",
              )}
              role="status"
            >
              <Wifi className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {test.reachable
                  ? test.setupCompleted === false
                    ? "الخادم يستجيب لكنه لم يُكمل الإعداد — لن يقبل تسجيل الدخول."
                    : `الخادم يستجيب (${test.latencyMs ?? "?"} ms)${test.setupCompleted ? " — الإعداد مكتمل" : ""}.`
                  : `لا يستجيب: ${test.error ?? "خطأ غير معروف"}`}
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => testMut.mutate()}
              disabled={!effectiveUrl || testMut.isPending}
            >
              {testMut.isPending ? (
                <Loader2 className="ml-1 h-4 w-4 animate-spin" />
              ) : (
                <PlugZap className="ml-1 h-4 w-4" />
              )}
              اختبار الاتصال
            </Button>
            <Button type="submit" disabled={connectMut.isPending}>
              {connectMut.isPending ? (
                <Loader2 className="ml-1 h-4 w-4 animate-spin" />
              ) : (
                <CloudCog className="ml-1 h-4 w-4" />
              )}
              حفظ وربط
            </Button>
          </div>
        </form>
      </PageCard>

      {isTauri() && <FactoryResetCard />}

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="فصل الجهاز عن المركز؟"
        description="يتوقف إرسال العمليات واستقبالها. العمليات غير المرسلة تبقى محفوظة محلياً وتُرسل عند إعادة الربط."
        confirmLabel="فصل"
        onConfirm={() => disconnectMut.mutate()}
      />
    </>
  );
}

function Row({
  label,
  value,
  mono,
  danger,
}: {
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "truncate font-medium",
          mono && "font-mono text-xs",
          danger && "text-destructive",
        )}
        dir={mono ? "ltr" : undefined}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
