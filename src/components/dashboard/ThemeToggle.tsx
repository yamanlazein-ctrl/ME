import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="تبديل الوضع"
      title={theme === "dark" ? "الوضع النهاري" : "الوضع الليلي"}
      className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:text-primary hover:border-primary/40 transition cursor-pointer"
    >
      {theme === "dark" ? (
        <Sun className="h-4 w-4" strokeWidth={1.9} />
      ) : (
        <Moon className="h-4 w-4" strokeWidth={1.9} />
      )}
    </button>
  );
}
