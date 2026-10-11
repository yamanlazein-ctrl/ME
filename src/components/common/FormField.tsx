import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Controls a field wires to its label by itself: a single plain text input or text area. */
const AUTO_WIRED = new Set<unknown>([Input, Textarea]);

/**
 * A labelled form field. The label is tied to its control (`<label for>`), so the control has an
 * accessible name: screen readers announce it and tests find it with `getByLabel`.
 *
 * - A single `<Input>` / `<Textarea>` child is wired automatically (`useId`), keeping its own `id`.
 * - Anything else (a `Select`, a composite control) passes `htmlFor` and puts that id on the
 *   focusable element itself (e.g. `<SelectTrigger id>`). Several controls in one field are never
 *   given the same id.
 */
export function FormField({
  label,
  error,
  children,
  className,
  htmlFor,
}: {
  label: string;
  error?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  const autoId = useId();
  const wired =
    !htmlFor && isValidElement(children) && AUTO_WIRED.has(children.type)
      ? (children as ReactElement<{ id?: string }>)
      : null;
  const controlId = htmlFor ?? (wired ? (wired.props.id ?? autoId) : undefined);
  return (
    <div className={className}>
      <Label
        htmlFor={controlId}
        className="mb-1 block text-[11px] font-semibold text-muted-foreground"
      >
        {label}
      </Label>
      {wired && !wired.props.id ? cloneElement(wired, { id: controlId }) : children}
      {error && (
        <p className="mt-1 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
