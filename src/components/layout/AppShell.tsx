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
  Settings as SettingsIcon,
  Activity,
  Save,
  Users as UsersIcon,
  FileText,
  ClipboardList,
  Printer,
  BarChart3,
  FileStack,
  Send,
  Inbox,
  LogOut,
  Menu,
  PanelRightClose,
  PanelRightOpen,
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
      { to: "/reports", label: "التقارير", icon: BarChart3 },
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
      { to: "/settings/audit", label: "حالة النظام", icon: FileText },
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

  // Lock body scroll + close on Escape when mobile drawer is open
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

  const sidebarWidthClass = collapsed ? "w-14" : "w-56";

  const renderNav = (isMobile: boolean) => (
    <nav
      className={cn(
        "flex h-full flex-col rounded-xl border border-border bg-card p-2 shadow-soft",
        isMobile ? "" : "sticky top-2 h-[calc(100vh-1rem)]",
      )}
    >
      {/* Collapse toggle — sits above the dashboard link (desktop only) */}
      {!isMobile && (
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cn(
            "mb-2 flex items-center rounded-lg border border-border bg-secondary/40 text-muted-foreground hover:text-primary hover:border-primary/40 transition",
            collapsed ? "justify-center p-2" : "gap-2 px-3 py-2 text-[12px] font-medium",
          )}
          aria-label={collapsed ? "فتح القائمة" : "طي القائمة"}
          title={collapsed ? "فتح القائمة" : "طي القائمة"}
        >
          {collapsed ? (
            <PanelRightOpen className="h-4 w-4" />
          ) : (
            <PanelRightClose className="h-4 w-4" />
          )}
          {!collapsed && <span>طي القائمة</span>}
        </button>
      )}
      {(() => {
        const dashActive = pathname === "/";
        return (
          <Link
            to="/"
            className={cn(
              "mb-2 flex items-center rounded-lg text-sm font-semibold transition border-r-4",
              collapsed && !isMobile ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2.5",
              dashActive
                ? "bg-primary/10 text-primary border-primary"
                : "border-transparent text-foreground hover:bg-secondary",
            )}
            title="لوحة التحكم"
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" strokeWidth={2} />
            {(!collapsed || isMobile) && <span className="truncate">لوحة التحكم</span>}
          </Link>
        );
      })()}

      <ul className="space-y-1 overflow-y-auto pr-0.5 flex-1 min-h-0 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/60 [scrollbar-width:thin]">
        {visibleGroups.map((g) => {
          const isOpen = open === g.key;
          const containsActive = g.items.some((it) =>
            it.exact ? pathname === it.to : pathname.startsWith(it.to),
          );

          if (collapsed && !isMobile) {
            // Icon-only mode: skip group headers, render items directly
            return (
              <li key={g.key} className="border-t border-border/40 first:border-0 pt-1 first:pt-0">
                {g.items.map((n) => {
                  const active = pathname === n.to || (!n.exact && pathname.startsWith(n.to + "/"));
                  return (
                    <Link
                      key={n.to}
                      to={n.to}
                      title={n.label}
                      className={cn(
                        "flex items-center justify-center rounded-lg p-2 my-0.5 transition border-r-4",
                        active
                          ? "bg-primary/10 text-primary border-primary"
                          : "border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      <n.icon className="h-4 w-4 shrink-0" strokeWidth={2} />
                    </Link>
                  );
                })}
              </li>
            );
          }

          return (
            <li key={g.key}>
              <button
                type="button"
                onClick={() => toggleGroup(g.key)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition",
                  containsActive ? "text-foreground" : "text-muted-foreground",
                  "hover:bg-secondary",
                )}
              >
                <span>{g.label}</span>
                <ChevronDown
                  className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-180")}
                />
              </button>
              {isOpen && (
                <ul className="mt-1 space-y-1 pb-1">
                  {g.items.map((n) => {
                    const active =
                      pathname === n.to || (!n.exact && pathname.startsWith(n.to + "/"));
                    return (
                      <li key={n.to}>
                        <Link
                          to={n.to}
                          className={cn(
                            "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition border-r-4",
                            active
                              ? "bg-primary/10 text-primary border-primary"
                              : "border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
                          )}
                        >
                          <n.icon className="h-4 w-4 shrink-0" strokeWidth={2} />
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

      {/* User footer */}
      <div className="mt-2 border-t border-border pt-2">
        {me && !collapsed && (
          <div className="flex items-center rounded-lg bg-secondary/40 px-2 py-1.5" title={me.name}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold text-foreground">{me.name}</div>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => logout.mutate()}
          title="تسجيل الخروج"
          className={cn(
            "mt-1.5 flex w-full items-center rounded-lg text-[12px] font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition",
            collapsed && !isMobile ? "justify-center p-2" : "gap-2 px-2 py-1.5",
          )}
        >
          <LogOut className="h-3.5 w-3.5 shrink-0" />
          {(!collapsed || isMobile) && <span>تسجيل الخروج</span>}
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen overflow-x-clip bg-background text-foreground" dir="rtl">
      <Header />
      <div className="flex w-full gap-2 px-1.5 py-1.5 sm:px-2 sm:py-2">
        <aside
          className={cn(
            "hidden lg:block shrink-0 transition-[width] duration-200",
            sidebarWidthClass,
          )}
        >
          {renderNav(false)}
        </aside>

        {/* Mobile drawer (animated) */}
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
            "fixed right-0 top-0 z-50 flex h-[100dvh] w-[85vw] max-w-[20rem] flex-col bg-card border-l border-border shadow-2xl transition-transform duration-300 ease-out lg:hidden",
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
            className="absolute left-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full bg-card border border-border shadow-soft"
            aria-label="إغلاق القائمة"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">{renderNav(true)}</div>
        </aside>

        <main className="flex-1 min-w-0 space-y-4">
          {/* Sidebar toggle bar */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:text-primary hover:border-primary/40 transition lg:hidden"
              aria-label="فتح القائمة"
              aria-expanded={mobileOpen}
            >
              <Menu className="h-5 w-5" />
            </button>
            {(title || actions) && (
              <div className="flex flex-1 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  {title && <h1 className="truncate text-xl font-bold text-foreground">{title}</h1>}
                  {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
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
