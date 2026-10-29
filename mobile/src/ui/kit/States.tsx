import { ActivityIndicator, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../Text";
import { spacing } from "../theme";
import { useColors } from "../themeContext-core";
import { Button } from "./Button";

function Centered({ children, testID }: { children: React.ReactNode; testID: string }) {
  return (
    <View
      testID={testID}
      style={{
        alignItems: "center",
        justifyContent: "center",
        padding: spacing.xxl,
        gap: spacing.md,
      }}
    >
      {children}
    </View>
  );
}

export function LoadingState({ label = "جارٍ التحميل…" }: { label?: string }) {
  const colors = useColors();
  return (
    <Centered testID="state-loading">
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={{ color: colors.mutedForeground }}>{label}</Text>
    </Centered>
  );
}

export function EmptyState({
  title,
  hint,
  icon = "file-tray-outline",
  action,
}: {
  title: string;
  hint?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  action?: { label: string; onPress: () => void };
}) {
  const colors = useColors();
  return (
    <Centered testID="state-empty">
      <Ionicons name={icon} size={40} color={colors.mutedForeground} />
      <Text style={{ fontWeight: "600", textAlign: "center" }}>{title}</Text>
      {hint ? (
        <Text style={{ color: colors.mutedForeground, textAlign: "center" }}>{hint}</Text>
      ) : null}
      {action ? <Button label={action.label} onPress={action.onPress} block={false} /> : null}
    </Centered>
  );
}

/** A failure the user can act on: what went wrong in plain words, and "try again". Never a raw stack or SQL text. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const colors = useColors();
  return (
    <Centered testID="state-error">
      <Ionicons name="alert-circle-outline" size={40} color={colors.negative} />
      <Text style={{ color: colors.negative, textAlign: "center" }}>{message}</Text>
      {onRetry ? (
        <Button label="إعادة المحاولة" variant="secondary" onPress={onRetry} block={false} />
      ) : null}
    </Centered>
  );
}

/** An inline message inside a form: icon + text, so meaning never rests on colour alone. */
export function Notice({
  kind,
  text,
  testID,
}: {
  kind: "error" | "warning" | "info" | "success";
  text: string;
  testID?: string;
}) {
  const colors = useColors();
  const tone = {
    error: { color: colors.negative, icon: "alert-circle" as const },
    warning: { color: colors.warning, icon: "warning" as const },
    info: { color: colors.mutedForeground, icon: "information-circle" as const },
    success: { color: colors.positive, icon: "checkmark-circle" as const },
  }[kind];
  return (
    <View
      {...(testID ? { testID } : {})}
      accessibilityRole={kind === "error" ? "alert" : undefined}
      style={{
        flexDirection: "row",
        gap: spacing.sm,
        alignItems: "flex-start",
        padding: spacing.md,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: tone.color,
        backgroundColor: colors.card,
      }}
    >
      <Ionicons name={tone.icon} size={20} color={tone.color} />
      <Text style={{ color: tone.color, flex: 1 }}>{text}</Text>
    </View>
  );
}

/** What a failed read says to the user: the use-case's own Arabic message, else a plain sentence (never SQL or a stack). */
export function readErrorText(error: unknown): string {
  const m = error instanceof Error ? error.message : "";
  return m && /[؀-ۿ]/.test(m) ? m : "تعذّر تحميل البيانات من قاعدة الهاتف.";
}
