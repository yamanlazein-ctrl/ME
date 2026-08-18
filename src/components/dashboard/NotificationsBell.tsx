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
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="التنبيهات"
          className="relative grid h-10 w-10 place-items-center rounded-lg border border-border bg-background text-foreground hover:bg-secondary transition cursor-pointer"
        >
          <Bell className="h-5 w-5" strokeWidth={1.75} />
          {unread && unread > 0 && (
            <span className="absolute -top-1 -left-1 grid h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground tabular-nums">
              {unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" dir="rtl">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="text-sm font-bold">التنبيهات ({unread ?? 0})</div>
          <button
            onClick={() => dismissAll.mutate()}
            className="text-xs text-primary hover:underline"
          >
            تعليم الكل كمقروء
          </button>
        </div>
        <div className="max-h-[420px] overflow-y-auto divide-y divide-border">
          {(!notifications || notifications.length === 0) && (
            <div className="p-6 text-center text-xs text-muted-foreground">لا تنبيهات جديدة.</div>
          )}
          {notifications?.map((n) => (
            <Link
              key={n.id}
              to={n.to?.path ?? "/"}
              className="block px-3 py-2.5 hover:bg-secondary/60"
            >
              <div className="flex items-start gap-2">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${n.severity === "critical" ? "bg-destructive" : n.severity === "warning" ? "bg-warning" : "bg-primary"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-foreground truncate">{n.title}</div>
                  {n.detail && <div className="text-[11px] text-muted-foreground">{n.detail}</div>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
