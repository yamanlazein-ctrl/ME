import { useRef, useCallback } from "react";

export interface ValidationRule {
  field: string;
  label: string;
  test: () => boolean;
}

export interface ValidationResult {
  valid: boolean;
  firstError?: string;
}

export function useFormValidation(rules: ValidationRule[]) {
  const firstErrorRef = useRef<string | null>(null);

  const validate = useCallback((): ValidationResult => {
    for (const rule of rules) {
      if (!rule.test()) {
        firstErrorRef.current = rule.label;
        return { valid: false, firstError: rule.label };
      }
    }
    firstErrorRef.current = null;
    return { valid: true };
  }, [rules]);

  const scrollToFirstError = useCallback(() => {
    const name = firstErrorRef.current;
    if (!name) return;
    const el = document.querySelector<HTMLElement>(`[data-field-error="${name}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const input = el.querySelector<HTMLElement>("input, select, textarea, [role=combobox]");
      input?.focus();
    }
  }, []);

  return { validate, scrollToFirstError };
}
