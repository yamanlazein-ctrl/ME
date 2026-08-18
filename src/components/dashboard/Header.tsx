import { NotificationsBell } from "./NotificationsBell";
import { GlobalSearch } from "./GlobalSearch";
import { ThemeToggle } from "./ThemeToggle";
import { settings } from "@/presentation/hooks/useSettings";
import logoUrl from "@/assets/logo-motard.png";
import { Store, RefreshCw } from "lucide-react";

export function Header() {
  const branchName = settings.company?.name ?? "";
  const lastSync = new Date().toLocaleTimeString("ar-SY", {
    hour: "2-digit",
    minute: "2-digit",
    numberingSystem: "latn",
  });

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex h-14 sm:h-16 items-center gap-3 sm:gap-5 px-2 sm:px-4">
        {/* Right (RTL start): logo + branch name */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0">
          <img
            src={logoUrl}
            alt="Motard Fabrics Group"
            className="h-8 sm:h-10 w-auto object-contain shrink-0 bg-transparent"
            style={{ background: "transparent" }}
          />
          {branchName && (
            <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
              <Store className="h-3.5 w-3.5 shrink-0 text-primary/70" strokeWidth={2} />
              <span className="truncate font-medium text-foreground/80">{branchName}</span>
            </div>
          )}
        </div>

        {/* Center: search — bounded, not stretched */}
        <div className="flex-1 flex justify-center min-w-0">
          <div className="w-full max-w-[420px]">
            <GlobalSearch />
          </div>
        </div>

        {/* Left (RTL end): last sync + theme + notifications */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className="hidden lg:flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
            <RefreshCw className="h-3 w-3 text-primary/60" strokeWidth={2} />
            <span>آخر مزامنة {lastSync}</span>
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
