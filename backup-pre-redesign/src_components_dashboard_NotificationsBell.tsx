import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Bell } from "lucide-react";
import {
  useNotifications,
  useDismissNotifications,
  useUnreadCount,
} from "@/presentation/hooks/useNotifications";
import { Link } from "@tanstack/react-router";

export function NotificationsBell() {
  const { data: notifications } = useNotifications();
  const { data: unread } = useUnreadCount();
  const dismissAll = useDismissNotifications();
  const count = unread ?? 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="التنبيهات"
          className="relative grid h-10 w-10 place-items-center rounded-full border border-border bg-card text-foreground transition duration-200 hover:border-primary/40 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background cursor-pointer"
        >
          <Bell className="h-[18px] w-[18px]" strokeWidth={2} />
          {count > 0 && (
            <span
              className="absolute grid h-[18px] min-w-[18px] place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground tabular-nums ring-2 ring-background"
              style={{ top: "-0.25rem", insetInlineStart: "-0.25rem" }}
            >
              {count > 9 ? "9+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" dir="rtl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <Bell className="h-3.5 w-3.5" strokeWidth={2} />
            </span>
            <span className="text-sm font-bold text-foreground">التنبيهات</span>
            {count > 0 && (
              <span className="rounded-md bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive tabular-nums">
                {count}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismissAll.mutate()}
            className="rounded text-xs font-medium text-primary transition-colors hover:text-primary-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            تعليم الكل كمقروء
          </button>
        </div>
        <div className="max-h-[420px] divide-y divide-border overflow-y-auto">
          {(!notifications || notifications.length === 0) && (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-muted-foreground">
              <Bell className="h-7 w-7 opacity-50" strokeWidth={1.5} />
              <span className="text-xs">لا تنبيهات جديدة.</span>
            </div>
          )}
          {notifications?.map((n) => (
            <Link
              key={n.id}
              to={n.to?.path ?? "/"}
              className="group flex items-start gap-2.5 px-4 py-3 transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:bg-secondary/60"
            >
              <span
                className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                  n.severity === "critical"
                    ? "bg-destructive"
                    : n.severity === "warning"
                      ? "bg-warning"
                      : "bg-primary"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-foreground">
                  {n.title}
                </div>
                {n.detail && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {n.detail}
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
