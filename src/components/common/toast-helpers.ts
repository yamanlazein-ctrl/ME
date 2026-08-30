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
    // Theme tokens are FULL color values (oklch/hex), NOT HSL channel triplets —
    // wrapping them in hsl() produced hsl(oklch(...)), which is invalid CSS and
    // made the toast render with a fully transparent background.
    style: { background: "var(--destructive)", color: "var(--destructive-foreground)" },
  });
}

export { sonnerToast as toast };
