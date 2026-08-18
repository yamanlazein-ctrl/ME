import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, FileText, Package, ShoppingCart } from "lucide-react";

type Variant = "entry" | "sale";

export function InvoiceHeader({
  variant,
  invoiceNumber,
  date,
  status = "مسودة",
  actions,
}: {
  variant: Variant;
  invoiceNumber: string;
  date: string;
  status?: string;
  actions?: ReactNode;
}) {
  const meta =
    variant === "entry"
      ? {
          title: "فاتورة دخول جديدة",
          subtitle: "استلام قماش من المورد إلى المستودع",
          icon: Package,
          accent: "from-primary/15 via-primary/5 to-transparent",
          badge: "دخول",
        }
      : {
          title: "فاتورة بيع جديدة",
          subtitle: "تسليم بضاعة إلى عميل — خصم مباشر من رصيد الصبغات",
          icon: ShoppingCart,
          accent: "from-primary/15 via-primary/5 to-transparent",
          badge: "بيع",
        };
  const Icon = meta.icon;

  return (
    <div className={`relative overflow-hidden rounded-xl border border-border bg-card`}>
      <div className={`absolute inset-0 bg-gradient-to-l ${meta.accent} pointer-events-none`} />
      <div className="relative flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-center gap-4">
          <Link
            to="/"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-background text-muted-foreground transition hover:text-foreground"
            aria-label="رجوع"
          >
            <ArrowRight className="h-4 w-4" />
          </Link>
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-bold text-foreground">{meta.title}</h1>
              <span className="rounded-md border border-border bg-secondary/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {meta.badge}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta.subtitle}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <MetaChip
            icon={<FileText className="h-3.5 w-3.5" />}
            label="رقم"
            value={invoiceNumber}
            mono
          />
          <MetaChip label="التاريخ" value={date} mono />
          <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            {status}
          </span>
          {actions}
        </div>
      </div>
    </div>
  );
}

function MetaChip({
  icon,
  label,
  value,
  mono,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
      {icon}
      <span>{label}:</span>
      <span className={`font-semibold text-foreground ${mono ? "tabular-nums" : ""}`}>{value}</span>
    </span>
  );
}

/** Numbered workflow strip: 1 → 2 → 3 → 4 */
export function WorkflowSteps({ steps, active }: { steps: string[]; active: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5">
      {steps.map((s, i) => {
        const state = i < active ? "done" : i === active ? "active" : "todo";
        return (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold ${
                state === "active"
                  ? "bg-primary text-primary-foreground shadow-[0_0_0_3px_hsl(var(--primary)/0.15)]"
                  : state === "done"
                    ? "bg-primary/20 text-primary"
                    : "bg-secondary text-muted-foreground"
              }`}
            >
              {i + 1}
            </div>
            <span
              className={`text-xs font-medium ${
                state === "todo" ? "text-muted-foreground" : "text-foreground"
              }`}
            >
              {s}
            </span>
            {i < steps.length - 1 && <div className="mx-1 h-px w-6 bg-border sm:w-10" />}
          </div>
        );
      })}
    </div>
  );
}

/** Section card with tight header. Replaces PageCard for the new invoice layout. */
export function Section({
  step,
  title,
  hint,
  actions,
  children,
  padded = true,
  tone = "default",
}: {
  step?: number;
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  tone?: "default" | "primary";
}) {
  return (
    <section
      className={`overflow-hidden rounded-xl border ${
        tone === "primary" ? "border-primary/30 bg-primary/[0.03]" : "border-border bg-card"
      }`}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {step !== undefined && (
            <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/15 text-xs font-bold text-primary">
              {step}
            </div>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-foreground">{title}</h2>
            {hint && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{hint}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}
