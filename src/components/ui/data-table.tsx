import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
import { Loader2 } from "lucide-react";

/**
 * DataTable baseline — every table in the app must render through this shell.
 *
 * Guarantees:
 *  • Fixed row height (density-tokenized, comfortable by default)
 *  • Sticky header
 *  • Uniform empty / loading / error states
 *  • Tabular-nums for numeric columns (add `tabular-nums` on <td>)
 *
 * Advanced features (inline edit, arrow-key nav, column resize) are layered
 * on progressively per screen — this shell only owns the baseline contract.
 */
export type Density = "comfortable" | "compact" | "ultra";

const rowHeightVar: Record<Density, string> = {
  comfortable: "var(--ds-row-h)",
  compact: "var(--ds-row-h-compact)",
  ultra: "var(--ds-row-h-ultra)",
};

export function DataTable({
  children,
  density = "comfortable",
  className,
  isLoading,
  error,
  isEmpty,
  emptyTitle,
  emptyDescription,
  emptyAction,
  onRetry,
}: {
  children: ReactNode;
  density?: Density;
  className?: string;
  isLoading?: boolean;
  error?: string | null;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <ErrorState message={error} onRetry={onRetry} />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="grid place-items-center rounded-xl border border-border bg-card p-10 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (isEmpty) {
    return (
      <div className="rounded-xl border border-border bg-card">
        <EmptyState
          title={emptyTitle ?? "لا توجد بيانات"}
          description={emptyDescription}
          action={emptyAction}
        />
      </div>
    );
  }
  return (
    <div
      className={cn("relative overflow-auto rounded-xl border border-border bg-card", className)}
      style={{ ["--row-h" as string]: rowHeightVar[density] }}
    >
      <table className="w-full border-collapse text-sm tabular-nums">{children}</table>
    </div>
  );
}

export function DataTableHead({ children }: { children: ReactNode }) {
  return <thead className="sticky top-0 z-10 bg-secondary/70 backdrop-blur">{children}</thead>;
}

export function DataTableHeadRow({ children }: { children: ReactNode }) {
  return <tr className="border-b border-border">{children}</tr>;
}

export function DataTableHeadCell({
  children,
  className,
  align = "start",
}: {
  children: ReactNode;
  className?: string;
  align?: "start" | "end" | "center";
}) {
  return (
    <th
      className={cn(
        "h-11 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
        align === "start" && "text-start",
        align === "end" && "text-end",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function DataTableBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function DataTableRow({
  children,
  className,
  onClick,
  selected,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <tr
      onClick={onClick}
      data-selected={selected || undefined}
      style={{ height: "var(--row-h)" }}
      className={cn(
        "border-b border-border transition-colors last:border-b-0",
        "hover:bg-secondary/50",
        "data-[selected]:bg-primary/10",
        onClick && "cursor-pointer",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function DataTableCell({
  children,
  className,
  align = "start",
}: {
  children: ReactNode;
  className?: string;
  align?: "start" | "end" | "center";
}) {
  return (
    <td
      className={cn(
        "px-3 text-foreground",
        align === "start" && "text-start",
        align === "end" && "text-end",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </td>
  );
}
