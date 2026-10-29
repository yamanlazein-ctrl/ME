import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";
import { Text } from "./Text";
import { fontSize, radius, spacing } from "./theme";
import { useColors } from "./themeContext-core";

export const TOAST_VARIANTS = ["success", "error"] as const;
export type ToastVariant = (typeof TOAST_VARIANTS)[number];

export function ToastView({ variant, message }: { variant: ToastVariant; message: string }) {
  const colors = useColors();
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={message}
      testID={`toast-${variant}`}
      style={{
        backgroundColor: variant === "success" ? colors.positive : colors.negative,
        borderRadius: radius.lg,
        padding: spacing.lg,
        margin: spacing.lg,
      }}
    >
      <Text style={{ color: colors.primaryForeground, fontSize: fontSize.body }}>{message}</Text>
    </View>
  );
}

interface ToastApi {
  /** A saved/created/sent message. Never rendered as an error. */
  success(message: string): void;
  /** A failure message. Never rendered as a success. */
  error(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ variant: ToastVariant; message: string } | null>(null);
  const show = useCallback((variant: ToastVariant, message: string) => {
    setToast({ variant, message });
    setTimeout(() => setToast(null), 4000);
  }, []);
  const api = useMemo<ToastApi>(
    () => ({ success: (m) => show("success", m), error: (m) => show("error", m) }),
    [show],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast ? <ToastView variant={toast.variant} message={toast.message} /> : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a ToastProvider");
  return api;
}
