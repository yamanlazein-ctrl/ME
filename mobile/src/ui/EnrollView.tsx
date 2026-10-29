// Linking the phone to the company hub (FR-07, FR-08): hub address + enrolment code (typed or scanned), then the first
// download with its progress. Every refusal says what to do next.
import { View } from "react-native";
import { Text } from "./Text";
import { ENROLL_ERROR_TEXT, type EnrollError } from "../core/enrollFlow";
import { Field } from "./Field";
import { radius, spacing } from "./theme";
import { useColors } from "./themeContext-core";
import { Button, Notice, Screen, Section } from "./kit";

export interface EnrollViewState {
  hub: string;
  code: string;
  busy: boolean;
  /** What the busy button is doing right now. */
  phase?: "waking" | "enrolling" | null;
  progress: { percent: number; applied: number; headSeq: number } | null;
  error: EnrollError | null;
  /** The hub's own refusal text (code expired, used up, device limit…), shown instead of the generic line. */
  hubMessage?: string | null;
  /** What the hub unit that could not apply says (entity type + reason), shown under the error. */
  detail?: string | null;
}

const PHASE_TEXT = {
  waking: "جارٍ الاتصال بالمركز… (قد يستغرق دقيقة إن كان الخادم نائماً)",
  enrolling: "جارٍ التحقق من رمز التسجيل…",
} as const;

function ProgressBar({ percent }: { percent: number }) {
  const colors = useColors();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(percent * 100) }}
      style={{
        height: 10,
        borderRadius: radius.sm,
        backgroundColor: colors.muted,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${Math.max(2, Math.round(percent * 100))}%`,
          height: "100%",
          backgroundColor: colors.primary,
        }}
      />
    </View>
  );
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
  const errorText = state.error ? (state.hubMessage ?? ENROLL_ERROR_TEXT[state.error]) : null;
  const errorBlock = errorText ? (
    <View style={{ gap: spacing.sm }}>
      <Notice kind="error" text={errorText} testID="enroll-error" />
      {state.detail ? (
        <Text testID="enroll-detail" style={{ color: colors.mutedForeground, fontSize: 13 }}>
          {state.detail}
        </Text>
      ) : null}
    </View>
  ) : null;

  if (progress) {
    const pct = Math.round(progress.percent * 100);
    return (
      <Screen
        title="ربط الهاتف بالمركز"
        subtitle="الخطوة 2 من 2: تحميل بيانات الشركة"
        back={false}
        footer={
          state.error && state.error !== "invalidCode" && onRetry ? (
            <Button label="إعادة المحاولة" onPress={onRetry} testID="enroll-retry" />
          ) : undefined
        }
      >
        <Section testID="enroll-progress">
          <Text>{`جارٍ التحميل: ${pct}%`}</Text>
          <ProgressBar percent={progress.percent} />
          <Text style={{ color: colors.mutedForeground }}>
            {progress.headSeq > 0
              ? `${progress.applied} من ${progress.headSeq} عملية`
              : `${progress.applied} عملية`}
          </Text>
          <Text style={{ color: colors.mutedForeground, fontSize: 14 }}>
            إن انقطع الاتصال أو أُغلق التطبيق، يكمل التحميل من حيث توقف.
          </Text>
        </Section>
        {errorBlock}
      </Screen>
    );
  }

  return (
    <Screen
      title="ربط الهاتف بالمركز"
      subtitle="الخطوة 1 من 2: بيانات المركز"
      back={false}
      footer={
        <Button
          label="تسجيل"
          busy={state.busy}
          busyLabel={PHASE_TEXT[state.phase ?? "enrolling"]}
          disabled={!state.hub.trim() || !state.code.trim()}
          onPress={onSubmit}
          testID="enroll-submit"
        />
      }
    >
      <Notice
        kind="info"
        text="تجد عنوان المركز ورمز التسجيل في برنامج الحاسوب: الإعدادات ← المزامنة السحابية ← أجهزة الشركة. يمكنك مسح رمز QR بدل الكتابة."
      />
      <Button label="مسح رمز QR" variant="secondary" icon="qr-code-outline" onPress={onScan} />
      <Section>
        <Field
          label="عنوان المركز"
          fieldId="hub"
          value={state.hub}
          onChangeText={(hub) => onChange({ hub })}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://…"
        />
        <Field
          label="رمز التسجيل"
          fieldId="code"
          value={state.code}
          onChangeText={(code) => onChange({ code })}
          autoCapitalize="characters"
          autoCorrect={false}
        />
      </Section>
      {errorBlock}
    </Screen>
  );
}
