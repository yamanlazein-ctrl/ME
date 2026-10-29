// PIN sign-in (FR-02): the roster as a picker, a numeric pad, and a link to the password form.
import { Pressable, View } from "react-native";
import { Text } from "./Text";
import type { RosterUser } from "../core/session";
import { Field } from "./Field";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export const PIN_LENGTH_MAX = 8;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"];

export interface LoginViewProps {
  users: RosterUser[];
  selectedId: string | null;
  pin: string;
  error: string | null;
  mode: "pin" | "password";
  email: string;
  password: string;
  onSelect(id: string): void;
  onKey(key: string): void;
  onToggleMode(): void;
  onChangeCredentials(patch: { email?: string; password?: string }): void;
  onSubmit(): void;
}

export function LoginView(p: LoginViewProps) {
  return (
    <View style={{ flex: 1, padding: spacing.lg, paddingTop: 64 }}>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.lg }}>تسجيل الدخول</Text>
      {p.mode === "pin" ? (
        <>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: spacing.sm,
              marginBottom: spacing.lg,
            }}
          >
            {p.users.map((u) => (
              <Pressable
                key={u.id}
                accessibilityRole="button"
                accessibilityState={{ selected: u.id === p.selectedId }}
                onPress={() => p.onSelect(u.id)}
                style={{
                  minHeight: TOUCH_TARGET,
                  justifyContent: "center",
                  paddingHorizontal: spacing.lg,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: u.id === p.selectedId ? colors.primary : colors.border,
                }}
              >
                <Text>{u.name}</Text>
              </Pressable>
            ))}
          </View>
          <Text
            testID="pin-dots"
            style={{ fontSize: fontSize.title, textAlign: "center", marginBottom: spacing.md }}
          >
            {"●".repeat(p.pin.length)}
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: spacing.sm,
            }}
          >
            {KEYS.map((k) => (
              <Pressable
                key={k}
                accessibilityRole="button"
                accessibilityLabel={k}
                onPress={() => p.onKey(k)}
                style={{
                  width: 80,
                  minHeight: TOUCH_TARGET + 8,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.md,
                  backgroundColor: colors.card,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              >
                <Text style={{ fontSize: fontSize.title }}>{k}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : (
        <>
          <Field
            label="البريد الإلكتروني"
            fieldId="email"
            value={p.email}
            autoCapitalize="none"
            onChangeText={(email) => p.onChangeCredentials({ email })}
          />
          <Field
            label="كلمة المرور"
            fieldId="password"
            value={p.password}
            secureTextEntry
            onChangeText={(password) => p.onChangeCredentials({ password })}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="دخول"
            onPress={p.onSubmit}
            style={{
              minHeight: TOUCH_TARGET,
              justifyContent: "center",
              alignItems: "center",
              backgroundColor: colors.primary,
              borderRadius: radius.md,
              marginTop: spacing.md,
            }}
          >
            <Text style={{ color: colors.primaryForeground }}>دخول</Text>
          </Pressable>
        </>
      )}
      {p.error ? (
        <Text testID="login-error" style={{ color: colors.negative, marginTop: spacing.md }}>
          {p.error}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="link"
        onPress={p.onToggleMode}
        style={{ marginTop: spacing.lg, minHeight: TOUCH_TARGET, justifyContent: "center" }}
      >
        <Text style={{ color: colors.primary }}>
          {p.mode === "pin" ? "الدخول بكلمة المرور" : "الدخول بالرمز السري"}
        </Text>
      </Pressable>
    </View>
  );
}
