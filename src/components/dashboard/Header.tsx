import { NotificationsBell } from "./NotificationsBell";
import { GlobalSearch } from "./GlobalSearch";
import { ThemeToggle } from "./ThemeToggle";
import { FxReferenceRate } from "./FxReferenceRate";
import { settings } from "@/presentation/hooks/useSettings";
import logoUrl from "@/assets/logo-motard.png";
import { Store, RefreshCw, Globe } from "lucide-react";

export function Header() {
  const branchName = settings.company?.name ?? "";
  const lastSync = new Date().toLocaleTimeString("ar-SY", {
    hour: "2-digit",
    minute: "2-digit",
    numberingSystem: "latn",
  });

  return (
    <header
      data-od-id="top-bar"
      className="sticky top-0 z-30 border-b border-border bg-background/80 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.45)] backdrop-blur-xl"
    >
      <div className="mx-auto flex h-14 items-center gap-3 px-3 sm:h-16 sm:gap-5 sm:px-5">
        {/* Start (RTL right): logo lockup + branch */}
        <div className="flex min-w-0 shrink-0 items-center gap-2.5">
          <img
            src={logoUrl}
            alt="Motard Fabrics Group"
            className="h-8 w-auto shrink-0 object-contain sm:h-9"
            style={{ background: "transparent" }}
          />
          {branchName && (
            <div className="hidden min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2.5 py-1 text-xs md:flex">
              <Store className="h-3.5 w-3.5 shrink-0 text-primary/80" strokeWidth={2} />
              <span className="truncate font-medium text-foreground/80">{branchName}</span>
            </div>
          )}
        </div>

        {/* Center: search */}
        <div className="flex min-w-0 flex-1 justify-center">
          <div className="w-full max-w-[440px]">
            <GlobalSearch />
          </div>
        </div>

        {/* End (RTL left): reference FX + last sync + theme + notifications */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
          <div className="hidden items-center gap-1.5 lg:flex">
            {/* Reference USD→SYP rate — DISPLAY-ONLY badge, fully isolated
                from invoice/voucher logic (exchangeRate stays manual). */}
            <FxReferenceRate />
            <div className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2.5 py-1 text-[11px] text-muted-foreground tabular-nums">
              <RefreshCw className="h-3 w-3 text-primary/70" strokeWidth={2} />
              <span>آخر مزامنة {lastSync}</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2.5 py-1 text-[11px] font-medium text-foreground/80">
              <Globe className="h-3 w-3 text-primary/70" strokeWidth={2} />
              <span>متصل</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <ThemeToggle />
            <NotificationsBell />
          </div>
        </div>
      </div>
    </header>
  );
}
