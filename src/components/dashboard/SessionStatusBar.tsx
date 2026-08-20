import { useEffect, useState } from "react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { Calendar, Clock, Globe, AlertCircle } from "lucide-react";

export function SessionStatusBar() {
  const { data } = useDashboard();
  const [today, setToday] = useState<string>("");
  useEffect(() => {
    setToday(
      new Date().toLocaleDateString("ar-SY", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        numberingSystem: "latn",
      }),
    );
  }, []);
  const session = data?.session;
  const isOpen = session?.open === true;
  // Format the opening date nicely: "٢٠٢٦/٠٨/١٩" → keep as-is from backend (already YYYY-MM-DD)
  const openedAtFormatted = session?.openedAt
    ? session.openedAt // backend returns YYYY-MM-DD, keep as readable date
    : "";

  return (
    <div className={`border-b bg-background ${isOpen ? "border-border" : "border-warning/40"}`}>
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5 text-xs sm:px-6">
        <span className="flex items-center gap-1.5 text-foreground">
          <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
          <span className="font-medium whitespace-nowrap" suppressHydrationWarning>
            {today}
          </span>
        </span>
        <span
          className={`flex items-center gap-1.5 font-medium whitespace-nowrap ${isOpen ? "text-foreground" : "text-warning"}`}
        >
          <Clock className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          {isOpen ? (
            <span className="whitespace-nowrap">افتتحت الجلسة {openedAtFormatted}</span>
          ) : (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <AlertCircle className="h-3 w-3" strokeWidth={2} />
              الجلسة غير مفتوحة
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Globe className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span className="font-medium whitespace-nowrap">متصل</span>
        </span>
      </div>
    </div>
  );
}
