import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Standard ERP section card.
 * Every screen uses the same shell: title, small description, clean border,
 * consistent padding — nothing floats in empty space.
 */
export function PageCard({
  title,
  description,
  actions,
  children,
  bodyClassName,
  noBodyPadding,
  className,
  tone = "default",
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  noBodyPadding?: boolean;
  className?: string;
  tone?: "default" | "primary";
}) {
  return (
    <section
      className={cn(
        "rounded-xl border bg-card shadow-soft",
        tone === "primary" ? "border-primary/30 bg-primary/5" : "border-border",
        className,
      )}
    >
      <header
        className={cn(
          "flex items-start justify-between gap-3 border-b px-5 py-3",
          tone === "primary" ? "border-primary/20" : "border-border",
        )}
      >
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-foreground">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={cn(noBodyPadding ? "" : "p-5", bodyClassName)}>{children}</div>
    </section>
  );
}
