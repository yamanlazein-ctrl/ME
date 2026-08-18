import { useEffect, useState } from "react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { Calendar, Clock, Globe } from "lucide-react";

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
  return (
    <div className="border-b border-border bg-background">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5 text-xs sm:px-6">
        <span className="flex items-center gap-1.5 text-foreground">
          <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
          <span className="font-medium whitespace-nowrap" suppressHydrationWarning>
            {today}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-foreground">
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={2} />
          <span className="font-medium whitespace-nowrap">افتتحت الجلسة {session?.openedAt}</span>
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Globe className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span className="font-medium whitespace-nowrap">متصل</span>
        </span>
      </div>
    </div>
  );
}
