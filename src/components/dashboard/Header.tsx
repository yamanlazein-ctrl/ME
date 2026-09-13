import { NotificationsBell } from "./NotificationsBell";
import { GlobalSearch } from "./GlobalSearch";
import { ThemeToggle } from "./ThemeToggle";
import { FxReferenceRate } from "./FxReferenceRate";
import { PRINT_BRAND_NAME } from "@/shared/constants/printConfig";
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
            {PRINT_BRAND_NAME}
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
            <NotificationsBell />
          </div>
        </div>
      </div>
    </header>
  );
}
