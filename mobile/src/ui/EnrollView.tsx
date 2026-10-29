import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { ENROLL_ERROR_TEXT, type EnrollError } from "../core/enrollFlow";
import { Field } from "./Field";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { fontSize, radius, spacing, TOUCH_TARGET } from "./theme";
import { useColors } from "./themeContext-core";

export interface EnrollViewState {
  hub: string;
  code: string;
  busy: boolean;
  progress: { percent: number; applied: number; headSeq: number } | null;
  error: EnrollError | null;
  /** What the hub unit that could not apply says (entity type + reason), shown under the error. */
  detail?: string | null;
}

export function EnrollView({
  state,
  onChange,
  onSubmit,
  onScan,
  onRetry,
}: {
  state: EnrollViewState;
  onChange(patch: Partial<Pick<EnrollViewState, "hub" | "code">>): void;
  onSubmit(): void;
  onScan(): void;
  onRetry?(): void;
}) {
  const colors = useColors();
  const { progress } = state;
  return (
    <View style={{ flex: 1, padding: spacing.lg, paddingTop: 64 }}>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.lg }}>ربط الهاتف بالمركز</Text>
      {progress ? (
        <View testID="enroll-progress">
          <Text>{`جارٍ التحميل: ${Math.round(progress.percent * 100)}%`}</Text>
          <Text>
            {progress.headSeq > 0
              ? `${progress.applied} من ${progress.headSeq} عملية`
              : `${progress.applied} عملية`}
          </Text>
        </View>
      ) : (
        <>
          <Field
            label="عنوان المركز"
            fieldId="hub"
            value={state.hub}
            onChangeText={(hub) => onChange({ hub })}
            autoCapitalize="none"
          />
          <Field
            label="رمز التسجيل"
            fieldId="code"
            value={state.code}
            onChangeText={(code) => onChange({ code })}
            autoCapitalize="none"
          />
          <Pressable
            accessibilityRole="button"
            onPress={onScan}
            style={{
              minHeight: TOUCH_TARGET,
              justifyContent: "center",
              alignItems: "center",
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: radius.md,
              marginTop: spacing.md,
            }}
          >
            <Text>مسح رمز QR</Text>
          </Pressable>
        </>
      )}
      {state.error ? (
        <Text testID="enroll-error" style={{ color: colors.negative, marginTop: spacing.md }}>
          {ENROLL_ERROR_TEXT[state.error]}
        </Text>
      ) : null}
      {state.error && state.detail ? (
        <Text testID="enroll-detail" style={{ marginTop: spacing.sm }}>
          {state.detail}
        </Text>
      ) : null}
      {progress && state.error && state.error !== "invalidCode" && onRetry ? (
        <Pressable
          accessibilityRole="button"
          testID="enroll-retry"
          onPress={onRetry}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            alignItems: "center",
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
            marginTop: spacing.md,
          }}
        >
          <Text>إعادة المحاولة</Text>
        </Pressable>
      ) : null}
      {progress ? null : (
        <PrimaryActionBar
          label={state.busy ? "جارٍ الاتصال…" : "تسجيل"}
          disabled={state.busy || !state.hub || !state.code}
          onPress={onSubmit}
        />
      )}
    </View>
  );
}
