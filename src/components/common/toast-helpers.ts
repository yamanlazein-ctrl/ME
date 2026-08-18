import { toast as sonnerToast } from "sonner";

export function showSuccess(message: string) {
  sonnerToast.success(message, {
    duration: 2000,
    position: "top-center",
    className: "rtl text-right",
  });
}

export function showError(message: string) {
  sonnerToast.error(message, {
    duration: 3000,
    position: "top-center",
    className: "rtl text-right",
    style: { background: "hsl(var(--destructive))", color: "hsl(var(--destructive-foreground))" },
  });
}

export { sonnerToast as toast };
