import { Outlet, Link, useRouterState, createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/settings")({ component: SettingsLayout });

const NAV = [
  { to: "/settings/company", label: "معلومات الشركة" },
  { to: "/settings/invoice", label: "إعدادات الفواتير" },
  { to: "/settings/currencies", label: "العملات" },
  { to: "/settings/taxes", label: "الضرائب" },
  { to: "/settings/warehouses", label: "المستودعات" },
  { to: "/settings/payment-methods", label: "طرق الدفع" },
  { to: "/settings/units", label: "وحدات القياس" },
  { to: "/settings/printing", label: "الطباعة" },
  { to: "/settings/backup", label: "النسخ الاحتياطي" },
  { to: "/settings/users", label: "المستخدمون والصلاحيات" },
  { to: "/settings/activity", label: "سجل النشاط" },
  { to: "/settings/audit", label: "حالة النظام" },
];

function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <AppShell title="الإعدادات" subtitle="إعدادات الشركة والنظام.">
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <aside>
          <nav className="rounded-lg border border-border bg-card p-2">
            <ul className="space-y-1">
              {NAV.map((n) => {
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
