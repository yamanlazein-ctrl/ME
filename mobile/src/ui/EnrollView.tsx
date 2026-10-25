import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { ENROLL_ERROR_TEXT, type EnrollError } from "../core/enrollFlow";
import { Field } from "./Field";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export interface EnrollViewState {
  hub: string;
  code: string;
  busy: boolean;
  progress: { percent: number; applied: number; headSeq: number } | null;
  error: EnrollError | null;
}

export function EnrollView({
  state,
  onChange,
  onSubmit,
  onScan,
}: {
  state: EnrollViewState;
  onChange(patch: Partial<Pick<EnrollViewState, "hub" | "code">>): void;
  onSubmit(): void;
  onScan(): void;
}) {
  const { progress } = state;
  return (
    <View style={{ flex: 1, padding: spacing.lg, paddingTop: 64 }}>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.lg }}>ربط الهاتف بالمركز</Text>
      {progress ? (
        <View testID="enroll-progress">
          <Text>{`جارٍ التحميل: ${Math.round(progress.percent * 100)}%`}</Text>
          <Text>{`${progress.applied} من ${progress.headSeq} عملية`}</Text>
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
