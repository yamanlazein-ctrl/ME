import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  Boxes,
  LayoutDashboard,
  PackagePlus,
  ShoppingCart,
  Truck,
  Users,
  Receipt,
  ArrowDownLeft,
  ArrowUpRight,
  RotateCcw,
  BookOpen,
  Wallet,
  ChevronDown,
  ChevronLeft,
  Settings as SettingsIcon,
  Activity,
  Save,
  Users as UsersIcon,
  ClipboardList,
  Printer,
  BarChart3,
  FileStack,
  Send,
  Inbox,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { Header } from "@/components/dashboard/Header";
import { cn } from "@/lib/utils";
import { useCurrentUser, useLogout } from "@/presentation/hooks/useAuth";
import { roleCanAccess, type UserRole } from "@/presentation/hooks/useSettings";

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; exact?: boolean };
type NavGroup = { key: string; label: string; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    key: "main",
    label: "القائمة الرئيسية",
    items: [
      { to: "/inventory", label: "المخزون", icon: Boxes },
      { to: "/customers", label: "العملاء", icon: Users },
      { to: "/suppliers", label: "الموردون", icon: Truck },
    ],
  },
  {
    key: "invoices",
    label: "الفواتير والمرتجعات",
    items: [
      { to: "/invoices/entry/new", label: "فاتورة دخول جديدة", icon: PackagePlus },
      { to: "/invoices/sale/new", label: "فاتورة بيع جديدة", icon: ShoppingCart },
      { to: "/invoices/print-send/new", label: "إرسال إلى المطبعة", icon: Send },
      { to: "/invoices/print-receive/new", label: "استلام من المطبعة", icon: Inbox },
      { to: "/returns/entry/new", label: "مرتجع دخول", icon: RotateCcw },
      { to: "/returns/sale/new", label: "مرتجع بيع", icon: RotateCcw },
      { to: "/returns", label: "سجل المرتجعات", icon: FileStack },
      { to: "/invoices/tracking", label: "تتبع الفواتير", icon: ClipboardList },
      { to: "/orders", label: "طلبات العملاء", icon: ClipboardList },
    ],
  },
  {
    key: "accounting",
    label: "المحاسبة",
    items: [
      { to: "/receipts", label: "سندات القبض", icon: ArrowDownLeft },
      { to: "/payments", label: "سندات الصرف", icon: ArrowUpRight },
      { to: "/expenses", label: "المصاريف", icon: Receipt },
      { to: "/ledger", label: "دفتر الحركات", icon: BookOpen },
      { to: "/cashbox", label: "الصندوق", icon: Wallet },
    ],
  },
  {
    key: "reports",
    label: "التقارير والطباعة",
    items: [
      { to: "/reports/", label: "التقارير", icon: BarChart3 },
      { to: "/print-center", label: "مركز الطباعة", icon: Printer },
    ],
  },
  {
    key: "admin",
    label: "الإدارة",
    items: [
      { to: "/settings/users", label: "المستخدمون والصلاحيات", icon: UsersIcon },
      { to: "/settings/activity", label: "سجل النشاط", icon: Activity },
      { to: "/settings", label: "الإعدادات", icon: SettingsIcon },
      { to: "/settings/backup", label: "النسخ الاحتياطي", icon: Save },
    ],
  },
];

const STORAGE_KEY = "erp.sidebar.openGroup";
const COLLAPSE_KEY = "erp.sidebar.collapsed";

function groupForPath(path: string): string {
  for (const g of GROUPS) {
    for (const it of g.items) {
      if (it.exact ? path === it.to : path.startsWith(it.to)) return g.key;
    }
  }
  return "main";
}

export function AppShell({
  children,
  title,
  subtitle,
  actions,
}: {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: me } = useCurrentUser();
  const logout = useLogout();
  const visibleGroups: NavGroup[] = me
    ? GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((it) => roleCanAccess(me.role as UserRole, it.to)),
      })).filter((g) => g.items.length > 0)
    : GROUPS;
  const activeGroup = groupForPath(pathname);
  const [open, setOpen] = useState<string>(activeGroup);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    try {
      const savedOpen = localStorage.getItem(STORAGE_KEY);
      if (savedOpen && GROUPS.some((g) => g.key === savedOpen)) setOpen(savedOpen);
      else setOpen(activeGroup);
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setOpen((prev) => (prev === activeGroup ? prev : activeGroup));
    setMobileOpen(false);
  }, [activeGroup, pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen]);

  const toggleGroup = (key: string) => {
    const next = open === key ? "" : key;
    setOpen(next);
    if (hydrated && next) {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    }
  };

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const n = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, n ? "1" : "0");
      } catch {
        /* ignore */
      }
      return n;
    });
  };

  const sidebarWidthClass = collapsed ? "w-16" : "w-56";
  const navItemBase =
    "group/item relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const navItemActive =
    "bg-primary/15 text-primary font-semibold shadow-[inset_3px_0_0_0_var(--primary)]";
  const navItemInactive =
    "text-foreground/65 hover:bg-secondary/80 hover:text-foreground";

  const renderNav = (isMobile: boolean) => {
    const collapsedDesktop = !isMobile && collapsed;
    return (
      <nav
        aria-label="القائمة الجانبية"
        className={cn(
          "relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-soft",
          isMobile ? "" : "sticky top-2 h-[calc(100vh-1rem)]",
        )}
      >
        {/* Soft brand wash */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-28 opacity-80"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in oklab, var(--primary) 14%, transparent), transparent)",
          }}
          aria-hidden
        />

        {!isMobile && (
          <div
            className={cn(
              "relative z-10 flex items-center border-b border-border/60",
              collapsedDesktop ? "justify-center px-2 py-3" : "justify-between gap-2 px-3 py-3",
            )}
          >
            {!collapsedDesktop && (
              <div className="min-w-0">
                <div className="truncate text-[11px] font-bold tracking-wide text-foreground">
                  القائمة
                </div>
                <div className="text-[10px] text-muted-foreground">تنقّل سريع</div>
              </div>
            )}
            <button
              type="button"
              onClick={toggleCollapsed}
              className={cn(
                "grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border/70 bg-background/60 text-muted-foreground transition hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label={collapsed ? "فتح القائمة" : "طي القائمة"}
              title={collapsed ? "فتح القائمة" : "طي القائمة"}
              aria-expanded={!collapsed}
            >
              <ChevronLeft
                className={cn(
                  "h-4 w-4 transition-transform duration-200 ease-out",
                  !collapsed && "rotate-180",
                )}
                strokeWidth={2}
              />
            </button>
          </div>
        )}

        <div className="relative z-10 flex min-h-0 flex-1 flex-col p-2">
          {(() => {
            const dashActive = pathname === "/";
            return (
              <Link
                to="/"
                title="لوحة التحكم"
                className={cn(
                  navItemBase,
                  "mb-2",
                  collapsedDesktop ? "justify-center px-0 py-2.5" : "",
                  dashActive ? navItemActive : navItemInactive,
                )}
              >
                <LayoutDashboard className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                {!collapsedDesktop && <span className="truncate">لوحة التحكم</span>}
                {collapsedDesktop && (
                  <span className="pointer-events-none absolute right-full z-20 mr-2 rounded-md bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover/item:opacity-100">
                    لوحة التحكم
                  </span>
                )}
              </Link>
            );
          })()}

          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pe-0.5 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/60 [scrollbar-width:thin]">
            {visibleGroups.map((g) => {
              const isOpen = open === g.key;
              const containsActive = g.items.some((it) =>
                it.exact ? pathname === it.to : pathname.startsWith(it.to),
              );

              if (collapsedDesktop) {
                return (
                  <li
                    key={g.key}
                    className="border-t border-border/40 pt-1.5 first:border-t-0 first:pt-0"
                  >
                    {g.items.map((n) => {
                      const active =
                        pathname === n.to || (!n.exact && pathname.startsWith(n.to + "/"));
                      return (
                        <Link
                          key={n.to}
                          to={n.to}
                          className={cn(
                            navItemBase,
                            "my-0.5 justify-center px-0 py-2.5",
                            active ? navItemActive : navItemInactive,
                          )}
                        >
                          <n.icon className="h-4 w-4 shrink-0" strokeWidth={2} />
                          <span className="pointer-events-none absolute right-full z-20 mr-2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover/item:opacity-100">
                            {n.label}
                          </span>
                        </Link>
                      );
                    })}
                  </li>
                );
              }

              return (
                <li
                  key={g.key}
                  className="border-t border-border/40 pt-1.5 first:border-t-0 first:pt-0"
                >
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={isOpen}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[10.5px] font-bold uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      containsActive ? "text-foreground" : "text-muted-foreground",
                      "hover:bg-secondary/70 hover:text-foreground",
                    )}
                  >
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          containsActive ? "bg-primary shadow-[0_0_6px_var(--primary)]" : "bg-border",
                        )}
                        aria-hidden
                      />
                      {g.label}
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-3.5 w-3.5 transition-transform duration-200",
                        isOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {isOpen && (
                    <ul className="mt-0.5 space-y-0.5 pb-1.5 ps-1">
                      {g.items.map((n) => {
                        const active =
                          pathname === n.to || (!n.exact && pathname.startsWith(n.to + "/"));
                        return (
                          <li key={n.to}>
                            <Link
                              to={n.to}
                              title={n.label}
                              className={cn(
                                navItemBase,
                                active ? navItemActive : navItemInactive,
                              )}
                            >
                              <n.icon className="h-4 w-4 shrink-0 opacity-90" strokeWidth={2} />
                              <span className="truncate">{n.label}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="mt-2 border-t border-border/70 pt-2">
            {me && !collapsedDesktop && (
              <div
                className="mb-1.5 flex items-center gap-2 rounded-xl border border-border/50 bg-secondary/30 px-2.5 py-2"
                title={me.name}
              >
                <div className="grid h-7 w-7 place-items-center rounded-full bg-primary/20 text-[11px] font-bold text-primary">
                  {me.name?.trim()?.charAt(0) || "م"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-foreground">{me.name}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{me.role}</div>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => logout.mutate()}
              title="تسجيل الخروج"
              className={cn(
                "flex w-full items-center rounded-lg text-[12px] font-medium text-foreground/65 transition duration-200 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                collapsedDesktop ? "justify-center p-2.5" : "gap-2 px-2.5 py-2",
              )}
            >
              <LogOut className="h-3.5 w-3.5 shrink-0" />
              {!collapsedDesktop && <span>تسجيل الخروج</span>}
            </button>
          </div>
        </div>
      </nav>
    );
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-background text-foreground" dir="rtl">
      <Header />
      <div className="flex w-full gap-3 px-2 py-2 sm:px-3 sm:py-2.5">
        <aside
          className={cn(
            "hidden shrink-0 transition-[width] duration-300 ease-out lg:block",
            sidebarWidthClass,
          )}
        >
          {renderNav(false)}
        </aside>

        <div
          className={cn(
            "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200 lg:hidden",
            mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          onClick={() => setMobileOpen(false)}
          aria-hidden={!mobileOpen}
        />
        <aside
          className={cn(
            "fixed right-0 top-0 z-50 flex h-[100dvh] w-[85vw] max-w-[20rem] flex-col border-l border-border bg-card shadow-2xl transition-transform duration-300 ease-out lg:hidden",
            mobileOpen ? "translate-x-0" : "translate-x-full",
          )}
          aria-hidden={!mobileOpen}
          role="dialog"
          aria-modal="true"
          aria-label="القائمة الجانبية"
        >
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="absolute left-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full border border-border bg-card shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="إغلاق القائمة"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto p-2 pt-10">{renderNav(true)}</div>
        </aside>

        <main className="min-w-0 flex-1 space-y-4">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:hidden"
              aria-label="فتح القائمة"
              aria-expanded={mobileOpen}
            >
              <Menu className="h-5 w-5" />
            </button>
            {(title || actions) && (
              <div className="flex flex-1 flex-wrap items-center justify-between gap-2.5">
                <div className="min-w-0">
                  {title && (
                    <h1 className="truncate text-base font-bold tracking-tight text-foreground">
                      {title}
                    </h1>
                  )}
                  {subtitle && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
                  )}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
              </div>
            )}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
