import { useEffect, useState } from "react";
import { AlertCircle, Download, Loader2, RefreshCw } from "lucide-react";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import {
  checkDesktopUpdate,
  getDesktopAppVersion,
  installDesktopUpdate,
  isTauri,
} from "@/infrastructure/tauri-bridge";
import {
  fetchUpdateStatus,
  type UpdateGateResponse,
} from "@/lib/license-update-status";

const IS_DESKTOP = import.meta.env.VITE_DESKTOP_DEPLOY === "true";

/**
 * Desktop-only: license Control Plane gate → optional Tauri CDN updater.
 * Hidden on web builds.
 */
export function DesktopUpdatesCard() {
  const [version, setVersion] = useState("…");
  const [gate, setGate] = useState<UpdateGateResponse | null>(null);
  const [cdn, setCdn] = useState<{ available: boolean; version?: string | null } | null>(null);
  const [busy, setBusy] = useState<"idle" | "gate" | "cdn" | "install">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_DESKTOP) return;
    void getDesktopAppVersion().then(setVersion).catch(() => setVersion("1.0.0"));
  }, []);

  if (!IS_DESKTOP) return null;

  async function refreshGate() {
    setBusy("gate");
    setError(null);
    setCdn(null);
    try {
      const token = getAccessToken();
      if (!token) throw new Error("سجّل الدخول أولاً");
      const ver = await getDesktopAppVersion();
      setVersion(ver);
      const status = await fetchUpdateStatus(token, ver);
      setGate(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل قراءة سياسة التحديث");
    } finally {
      setBusy("idle");
    }
  }

  async function probeCdn() {
    setBusy("cdn");
    setError(null);
    try {
      if (!gate?.mayCheckForUpdates) {
        throw new Error(gate?.reason || "التحديثات غير مسموحة حسب الترخيص");
      }
      if (!isTauri()) {
        throw new Error("شغّل التطبيق من مثبّت سطح المكتب للتحقق من CDN");
      }
      const result = await checkDesktopUpdate();
      setCdn(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل التحقق من التحديث");
    } finally {
      setBusy("idle");
    }
  }

  async function applyUpdate() {
    setBusy("install");
    setError(null);
    try {
      if (!gate?.mayCheckForUpdates) {
        throw new Error(gate?.reason || "التحديثات غير مسموحة حسب الترخيص");
      }
      await installDesktopUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "فشل تثبيت التحديث");
      setBusy("idle");
    }
  }

  return (
    <PageCard
      title="تحديثات سطح المكتب"
      description="سياسة التحديث من الترخيص (Control Plane). نشر الحزم يبقى على CDN."
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2">
          <span className="text-muted-foreground">الإصدار الحالي</span>
          <span className="font-mono tabular-nums" dir="ltr">
            {version}
          </span>
        </div>

        {gate && (
          <div
            className={`rounded-lg border px-3 py-2 ${
              gate.forceUpgrade
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : gate.mayCheckForUpdates
                  ? "border-border bg-secondary/20 text-foreground"
                  : "border-border bg-muted/40 text-muted-foreground"
            }`}
          >
            <div className="font-medium">{gate.reason}</div>
            <div className="mt-1 text-xs opacity-80" dir="ltr">
              channel={gate.policy.channel} · min={gate.policy.minimum_version} · allow=
              {String(gate.policy.allow_updates)}
            </div>
          </div>
        )}

        {cdn && (
          <div className="rounded-lg border border-border px-3 py-2">
            {cdn.available ? (
              <span>
                يتوفر تحديث{" "}
                <span className="font-mono" dir="ltr">
                  {cdn.version}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">لا يوجد تحديث على قناة CDN حالياً</span>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy !== "idle"}
            onClick={() => void refreshGate()}
            className="gap-2"
          >
            {busy === "gate" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            قراءة سياسة الترخيص
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== "idle" || !gate?.mayCheckForUpdates}
            onClick={() => void probeCdn()}
            className="gap-2"
          >
            {busy === "cdn" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            تحقق من CDN
          </Button>
          <Button
            type="button"
            disabled={busy !== "idle" || !gate?.mayCheckForUpdates || !cdn?.available}
            onClick={() => void applyUpdate()}
            className="gap-2"
          >
            {busy === "install" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            تنزيل وتثبيت
          </Button>
        </div>
      </div>
    </PageCard>
  );
}

/** Soft banner when install is below licensed minimum_version. */
export function ForceUpgradeBanner() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_DESKTOP) return;
    let cancelled = false;
    void (async () => {
      try {
        const token = getAccessToken();
        if (!token) return;
        const ver = await getDesktopAppVersion();
        const gate = await fetchUpdateStatus(token, ver);
        if (!cancelled && gate.forceUpgrade) setMsg(gate.reason);
      } catch {
        /* offline / starting — ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!msg) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {msg}
      <span className="ms-2 text-muted-foreground">— راجع الإعدادات ← النسخ الاحتياطي</span>
    </div>
  );
}
