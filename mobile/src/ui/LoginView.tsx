// Sign-in (FR-02): pick the user, then the 4-digit PIN. A user without a PIN first chooses one (entered twice), the same
// rule as the desktop's user picker. E-mail + password stays available as the online alternative.
import { Pressable, View } from "react-native";
import { Text } from "./Text";
import type { RosterUser } from "../core/session";
import type { Role } from "../core/roles";
import { Field } from "./Field";
import { fontSize, radius, spacing, TOUCH_TARGET } from "./theme";
import { useColors } from "./themeContext-core";
import { Badge, Button, ListRow, Notice, Screen, Section } from "./kit";

export const PIN_LENGTH = 4;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "مدير",
  accountant: "محاسب",
  warehouse: "أمين مستودع",
  viewer: "اطلاع فقط",
};

/** "enter": type the PIN; "choose"/"confirm": a user without a PIN picks one, then repeats it. */
export type PinStep = "enter" | "choose" | "confirm";

export interface LoginViewProps {
  users: RosterUser[];
  selectedId: string | null;
  pin: string;
  pinStep: PinStep;
  error: string | null;
  busy: boolean;
  mode: "pin" | "password";
  email: string;
  password: string;
  onSelect(id: string | null): void;
  onKey(key: string): void;
  onToggleMode(): void;
  onChangeCredentials(patch: { email?: string; password?: string }): void;
  onSubmit(): void;
}

const STEP_TEXT: Record<PinStep, string> = {
  enter: "أدخل رقمك السري (4 أرقام)",
  choose: "أول دخول لك من هذا الهاتف: اختر رقماً سرياً من 4 أرقام تستخدمه للدخول",
  confirm: "أعد إدخال الرقم السري نفسه للتأكيد",
};

function PinDots({ length }: { length: number }) {
  const colors = useColors();
  return (
    <View
      testID="pin-dots"
      accessibilityLabel={`${length} من ${PIN_LENGTH}`}
      style={{ flexDirection: "row", justifyContent: "center", gap: spacing.md }}
    >
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <View
          key={i}
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            borderWidth: 2,
            borderColor: colors.primary,
            backgroundColor: i < length ? colors.primary : "transparent",
          }}
        />
      ))}
    </View>
  );
}

function Keypad({ onKey, ready }: { onKey(k: string): void; ready: boolean }) {
  const colors = useColors();
  return (
    <View
      style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.sm }}
    >
      {KEYS.map((k) => {
        const submit = k === "✓";
        return (
          <Pressable
            key={k}
            accessibilityRole="button"
            accessibilityLabel={submit ? "دخول" : k === "⌫" ? "حذف" : k}
            accessibilityState={{ disabled: submit && !ready }}
            testID={`key-${k}`}
            onPress={() => onKey(k)}
            style={({ pressed }) => ({
              width: "30%",
              minHeight: TOUCH_TARGET + 12,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.lg,
              backgroundColor: submit ? (ready ? colors.primary : colors.muted) : colors.card,
              borderWidth: 1,
              borderColor: submit && ready ? colors.primary : colors.border,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                fontSize: fontSize.headline,
                color: submit && ready ? colors.primaryForeground : colors.foreground,
              }}
            >
              {k}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function LoginView(p: LoginViewProps) {
  const colors = useColors();
  const selected = p.users.find((u) => u.id === p.selectedId) ?? null;
  const toggle = (
    <Button
      variant="ghost"
      label={p.mode === "pin" ? "الدخول بالبريد وكلمة المرور" : "الدخول بالرقم السري"}
      onPress={p.onToggleMode}
      testID="login-mode"
    />
  );
  if (p.mode === "password") {
    return (
      <Screen
        title="تسجيل الدخول"
        subtitle="بالبريد وكلمة المرور (يحتاج اتصالاً بالمركز)"
        back={false}
      >
        <Section>
          <Field
            label="البريد الإلكتروني"
            fieldId="email"
            value={p.email}
            autoCapitalize="none"
            keyboardType="email-address"
            onChangeText={(email) => p.onChangeCredentials({ email })}
          />
          <Field
            label="كلمة المرور"
            fieldId="password"
            value={p.password}
            secureTextEntry
            onChangeText={(password) => p.onChangeCredentials({ password })}
          />
          {p.error ? <Notice kind="error" text={p.error} testID="login-error" /> : null}
          <Button
            label="دخول"
            busy={p.busy}
            busyLabel="جارٍ الدخول…"
            disabled={!p.email.trim() || !p.password}
            onPress={p.onSubmit}
          />
        </Section>
        {toggle}
      </Screen>
    );
  }
  if (!selected) {
    return (
      <Screen title="تسجيل الدخول" subtitle="اختر اسمك" back={false}>
        {p.users.length === 0 ? (
          <Notice
            kind="info"
            text="جارٍ جلب المستخدمين من المركز… إن طال الانتظار فتحقق من الاتصال."
          />
        ) : (
          <Section padded={false}>
            {p.users.map((u, i) => (
              <ListRow
                key={u.id}
                testID={`user-${u.id}`}
                title={u.name}
                subtitle={ROLE_LABEL[u.role] ?? u.role}
                value={
                  u.hasPin === false ? (
                    <Badge label="يحتاج رقماً سرياً" tone="warning" />
                  ) : undefined
                }
                onPress={() => p.onSelect(u.id)}
                last={i === p.users.length - 1}
              />
            ))}
          </Section>
        )}
        {p.error ? <Notice kind="error" text={p.error} testID="login-error" /> : null}
        {toggle}
      </Screen>
    );
  }
  return (
    <Screen title="تسجيل الدخول" subtitle={selected.name} back={false}>
      <View style={{ alignItems: "center", gap: spacing.md }}>
        <Text style={{ fontSize: fontSize.title, fontWeight: "700" }}>{selected.name}</Text>
        <Text testID="pin-step" style={{ color: colors.mutedForeground, textAlign: "center" }}>
          {STEP_TEXT[p.pinStep]}
        </Text>
        <PinDots length={p.pin.length} />
      </View>
      {p.error ? <Notice kind="error" text={p.error} testID="login-error" /> : null}
      <Keypad onKey={p.onKey} ready={p.pin.length === PIN_LENGTH && !p.busy} />
      {p.users.length > 1 ? (
        <Button variant="ghost" label="تغيير المستخدم" onPress={() => p.onSelect(null)} />
      ) : null}
      {toggle}
    </Screen>
  );
}
