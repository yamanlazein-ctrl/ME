import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";

export function FormField({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
        {label}
      </Label>
      {children}
      {error && (
        <p className="mt-1 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
