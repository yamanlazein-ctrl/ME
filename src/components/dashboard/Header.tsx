import { useEffect } from "react";
import { GitMerge } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useOpenSyncConflictCount } from "@/presentation/hooks/useSyncConflicts";
import { NotificationsBell } from "./NotificationsBell";
import { GlobalSearch } from "./GlobalSearch";
import { ThemeToggle } from "./ThemeToggle";
import { FxReferenceRate } from "./FxReferenceRate";
import { PRINT_BRAND_NAME } from "@/shared/constants/printConfig";
import { useSettings } from "@/presentation/hooks/useSettings";
import { useConnectivity } from "@/presentation/hooks/useConnectivity";
import { useAutoSync } from "@/presentation/hooks/useAutoSync";
import logoUrl from "@/assets/logo-motard-icon.png";
import { cn } from "@/lib/utils";

/**
 * Top bar — three clear zones with air between them.
 * Brand (start) · Search (middle) · Tools (end).
 */
export function Header() {
  const connectivity = useConnectivity();
  const { deviceGate, deviceTrust } = useAutoSync();
  const online = connectivity === "online";
  const conflictCount = useOpenSyncConflictCount();

  // F11 (Phase 1 audit): this used to always render PRINT_BRAND_NAME — a
  // constant, never fetched from anywhere. StoneERP is single-tenant-per
  // -install, so the live, editable company name from Settings (GET
  // /settings → PUT /settings/company) IS this install's one real
  // company identity; the dashboard and browser tab should reflect it,
  // not a hardcoded string. PRINT_BRAND_NAME stays as-is for PRINTED
  // documents (its own file documents that as a deliberate, separate,
  // user-approved constant) — only the live UI surfaces change here.
  const { company } = useSettings();
  const companyName = company.name?.trim() || PRINT_BRAND_NAME;

  useEffect(() => {
    document.title = companyName;
  }, [companyName]);

  return (
    <header
      data-od-id="top-bar"
      className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-md"
    >
      <div className="mx-auto flex h-[3.75rem] items-center gap-6 px-5 md:gap-10 md:px-8">
        {/* Zone 1 — Brand */}
        <div className="flex shrink-0 items-center gap-2.5">
          <img
            src={logoUrl}
            alt=""
            className="h-8 w-8 object-contain object-center"
            style={{ background: "transparent" }}
          />
          <span className="hidden max-w-[14rem] truncate text-[13px] font-semibold tracking-tight text-foreground sm:inline">
            {companyName}
          </span>
        </div>

        {/* Zone 2 — Search */}
        <div className="mx-auto w-full max-w-md flex-1">
          <GlobalSearch />
        </div>

        {/* Zone 3 — Tools */}
        <div className="flex shrink-0 items-center gap-5">
          <div className="hidden xl:block">
            <FxReferenceRate />
          </div>

          <span
            className={cn(
              "hidden items-center gap-1.5 text-[11px] font-medium lg:inline-flex",
              online ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
            )}
            title={online ? "الاتصال بالخادم متاح" : "لا يوجد اتصال بالخادم"}
            role="status"
            aria-live="polite"
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                online ? "bg-emerald-500" : "bg-destructive",
              )}
              aria-hidden
            />
            {online ? "متصل" : "غير متصل"}
          </span>
          {deviceGate && (
            <span
              className="hidden items-center gap-1.5 text-[11px] font-medium text-amber-600 lg:inline-flex dark:text-amber-400"
              title={
                deviceTrust?.code === "SYNC_DEVICE_REVOKED"
                  ? "أُلغي هذا الجهاز من المركز — لم تُحذف أي بيانات محلية. راجع المسؤول لإعادة تفعيل الجهاز"
                  : deviceTrust?.code === "SYNC_DEVICE_NOT_BOUND"
                    ? "هذا الجهاز غير مرتبط بحسابك — سجّل الجهاز من حسابك ثم أعد المزامنة"
                    : "المركز لا يعرف هذا الجهاز — سجّل الجهاز من الإعدادات ثم أعد المزامنة"
              }
              role="status"
              aria-live="polite"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
              {deviceTrust?.code === "SYNC_DEVICE_REVOKED" ? "الجهاز مُلغى" : "الجهاز غير مسجّل"}
            </span>
          )}

          <div className="flex items-center gap-0.5 border-s border-border ps-4">
            <ThemeToggle />
            <Link
              to="/sync/conflicts"
              aria-label="تعارضات المزامنة"
              className="relative grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <GitMerge className="h-[18px] w-[18px]" strokeWidth={2} />
              {conflictCount > 0 && (
                <span
                  className="absolute grid h-[18px] min-w-[18px] place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground tabular-nums ring-2 ring-background"
                  style={{ top: "-0.25rem", insetInlineStart: "-0.25rem" }}
                >
                  {conflictCount > 9 ? "9+" : conflictCount}
                </span>
              )}
            </Link>
            <NotificationsBell />
          </div>
        </div>
      </div>
    </header>
  );
}
