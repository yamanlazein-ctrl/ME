import { Outlet, Link, useRouterState, createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/presentation/hooks/useAuth";
import { hasAdminPrivileges } from "@/presentation/hooks/useSettings";

export const Route = createFileRoute("/settings")({ component: SettingsLayout });

const NAV: { to: string; label: string; adminOnly?: boolean }[] = [
  { to: "/settings/company", label: "معلومات الشركة" },
  { to: "/settings/invoice", label: "إعدادات الفواتير" },
  { to: "/settings/warehouses", label: "المستودعات" },
  { to: "/settings/payment-methods", label: "طرق الدفع" },
  { to: "/settings/units", label: "وحدات القياس" },
  { to: "/settings/printing", label: "الطباعة" },
  { to: "/settings/backup", label: "النسخ الاحتياطي" },
  { to: "/settings/users", label: "المستخدمون والصلاحيات" },
  { to: "/settings/activity", label: "سجل النشاط" },
  { to: "/settings/sync", label: "المزامنة السحابية", adminOnly: true },
  { to: "/settings/drive", label: "أرشيف Google Drive", adminOnly: true },
];

/**
 * C1-12: the settings area is admin-only (admin + accountant since 2026-10-12) — deny by default. Every settings WRITE on the server is
 * `rbac(["admin"])` (settings, users, invitations, backup, sync operator, Drive) and the role map
 * (`ROLE_ALLOWED_PATHS`) grants `/settings` to no other role; the pages used to open by direct URL
 * for anyone and only fail on save. Nothing renders until the role is known.
 */
function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: me, isLoading } = useCurrentUser();
  if (!me || !hasAdminPrivileges(me.role)) {
    return (
      <AppShell title="الإعدادات" subtitle="إعدادات الشركة والنظام.">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            جارٍ التحقق من الصلاحيات…
          </div>
        ) : (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
          >
            الإعدادات متاحة لمدير النظام والمحاسب فقط.
          </div>
        )}
      </AppShell>
    );
  }
  const nav = NAV;
  return (
    <AppShell title="الإعدادات" subtitle="إعدادات الشركة والنظام.">
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <aside>
          <nav className="rounded-lg border border-border bg-card p-2">
            <ul className="space-y-1">
              {nav.map((n) => {
                const active = pathname === n.to;
                return (
                  <li key={n.to}>
                    <Link
                      to={n.to}
                      className={cn(
                        "block rounded-md px-3 py-2 text-sm transition border-r-4",
                        active
                          ? "bg-primary/10 text-primary border-primary"
                          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                      )}
                    >
                      {n.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>
        <div className="min-w-0 space-y-4">
          <Outlet />
        </div>
      </div>
    </AppShell>
  );
}
