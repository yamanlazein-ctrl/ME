import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared error-state for cards, tables and panels.
 * Field-level errors should render inline next to the field, not here.
 */
export function ErrorState({
  title = "تعذّر تحميل البيانات",
  message,
  onRetry,
  className,
}: {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
      <div className="grid h-12 w-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {message && <div className="mt-1 text-xs text-muted-foreground">{message}</div>}
      </div>
      {onRetry && (
        <Button type="button" size="sm" variant="outline" onClick={onRetry} className="gap-1.5">
          <RotateCw className="h-3.5 w-3.5" /> إعادة المحاولة
        </Button>
      )}
    </div>
  );
}

/**
 * Inline field error — consistent, always placed directly below the input.
 * Never render a toast for field-level validation errors.
 */
export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="mt-1 text-[11px] font-medium text-destructive" role="alert">
      {message}
    </p>
  );
}
