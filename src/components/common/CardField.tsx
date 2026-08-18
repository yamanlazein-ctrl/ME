import { type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function CardField({
  label,
  required,
  error,
  children,
  className,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label
        className={cn(
          "mb-1 flex items-center gap-1 text-[11px] font-semibold",
          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      <div className={error ? "[&_input]:border-destructive [&_select]:border-destructive [&_[role=combobox]]:border-destructive" : ""}>
        {children}
      </div>
      {error && <p className="mt-0.5 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
