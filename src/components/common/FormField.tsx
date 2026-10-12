import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Controls a field wires to its label by itself: a single plain text input or text area. */
const AUTO_WIRED = new Set<unknown>([Input, Textarea]);

/** A control component outside this module opts in with `Component.autoWireId = true` (it forwards `id`). */
const isAutoWired = (type: unknown) =>
  AUTO_WIRED.has(type) || (type as { autoWireId?: boolean } | null)?.autoWireId === true;

/**
 * Ties a label to the control among `children`: an explicit `htmlFor` wins; otherwise the ONE
 * auto-wired control child gets a `useId` id (keeping its own `id`). Two candidates → none, so
 * several controls in one field are never given the same id.
 */
function useLabelledControl(children: ReactNode, htmlFor?: string) {
  const autoId = useId();
  if (htmlFor) return { controlId: htmlFor, control: children };
  const candidates = Children.toArray(children).filter(
    (c): c is ReactElement<{ id?: string }> => isValidElement(c) && isAutoWired(c.type),
  );
  if (candidates.length !== 1) return { controlId: undefined, control: children };
  const own = candidates[0].props.id;
  if (own) return { controlId: own, control: children };
  const control = Children.map(children, (c) =>
    isValidElement(c) && isAutoWired(c.type)
      ? cloneElement(c as ReactElement<{ id?: string }>, { id: autoId })
      : c,
  );
  return { controlId: autoId, control };
}

/**
 * A labelled form field. The label is tied to its control (`<label for>`), so the control has an
 * accessible name: screen readers announce it and tests find it with `getByLabel`.
 *
 * - A single `<Input>` / `<Textarea>` (or opted-in) child is wired automatically, keeping its own `id`.
 * - Anything else (a `Select`, a composite control) passes `htmlFor` and puts that id on the
 *   focusable element itself (e.g. `<SelectTrigger id>`).
 */
export function FormField({
  label,
  error,
  children,
  className,
  htmlFor,
  labelClassName = "mb-1 block text-[11px] font-semibold text-muted-foreground",
}: {
  label: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
  labelClassName?: string;
}) {
  const { controlId, control } = useLabelledControl(children, htmlFor);
  return (
    <div className={className}>
      <Label htmlFor={controlId} className={labelClassName}>
        {label}
      </Label>
      {control}
      {error && (
        <p className="mt-1 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
