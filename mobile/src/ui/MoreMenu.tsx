// The "more" tab: documents, money, reports and the phone's own settings (theme, sync, sign-out).
import { useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "./Text";
import type { ThemeName } from "./theme";
import { useColors } from "./themeContext-core";
import { Button, Chips, ListRow, Notice, Screen, Section, Sheet } from "./kit";

export type MoreTarget = "returns" | "orders" | "cashbox" | "closeDay" | "reports" | "sync";

const GROUPS: Array<{
  title: string;
  rows: Array<{
    id: MoreTarget;
    label: string;
    hint: string;
    icon: keyof typeof Ionicons.glyphMap;
  }>;
}> = [
  {
    title: "المستندات",
    rows: [
      {
        id: "returns",
        label: "المرتجعات",
        hint: "مرتجعات البيع والدخول، وإلغاؤها",
        icon: "return-down-back-outline",
      },
      {
        id: "orders",
        label: "الطلبيات",
        hint: "طلبيات العملاء وتنفيذها",
        icon: "clipboard-outline",
      },
    ],
  },
  {
    title: "المال",
    rows: [
      { id: "cashbox", label: "الصندوق", hint: "الرصيد والحركات اليدوية", icon: "cash-outline" },
      {
        id: "closeDay",
        label: "إقفال اليوم",
        hint: "مطابقة النقد في الصندوق وإقفال اليوم",
        icon: "lock-closed-outline",
      },
    ],
  },
  {
    title: "التقارير",
    rows: [
      {
        id: "reports",
        label: "التقارير",
        hint: "المبيعات، الأرباح، الذمم، المخزون…",
        icon: "bar-chart-outline",
      },
    ],
  },
];

export function MoreMenuView({
  userName,
  roleLabel,
  theme,
  pendingLogout,
  fontsStatus,
  onOpen,
  onTheme,
  onLogout,
  onCancelLogout,
}: {
  userName: string | null;
  roleLabel: string | null;
  theme: ThemeName;
  /** Unsent operations when the user asked to sign out (asks for confirmation); null when not asking. */
  pendingLogout: number | null;
  fontsStatus: string;
  onOpen(target: MoreTarget): void;
  onTheme(theme: ThemeName): void;
  onLogout(confirmed: boolean): Promise<void>;
  onCancelLogout(): void;
}) {
  const colors = useColors();
  const [asking, setAsking] = useState(false);
  return (
    <Screen
      title="المزيد"
      subtitle={userName ? `${userName}${roleLabel ? ` · ${roleLabel}` : ""}` : null}
      back={false}
    >
      {GROUPS.map((g) => (
        <Section key={g.title} title={g.title} padded={false}>
          {g.rows.map((r, i) => (
            <ListRow
              key={r.id}
              testID={`more-${r.id}`}
              accessibilityLabel={r.label}
              leading={<Ionicons name={r.icon} size={24} color={colors.primary} />}
              title={r.label}
              subtitle={r.hint}
              onPress={() => onOpen(r.id)}
              last={i === g.rows.length - 1}
            />
          ))}
        </Section>
      ))}
      <Section title="الهاتف">
        <Text>المظهر</Text>
        <Chips<ThemeName>
          options={[
            { value: "dark", label: "داكن" },
            { value: "light", label: "فاتح" },
          ]}
          value={theme}
          onChange={onTheme}
          testIDPrefix="theme"
        />
        <ListRow
          title="حالة المزامنة"
          subtitle="ما أُرسل إلى المركز وما ينتظر"
          leading={<Ionicons name="sync-outline" size={24} color={colors.primary} />}
          onPress={() => onOpen("sync")}
          testID="more-sync"
          last
        />
        <Text testID="fonts-status" style={{ color: colors.mutedForeground, fontSize: 13 }}>
          {fontsStatus}
        </Text>
      </Section>
      <Button
        label="تسجيل الخروج"
        variant="danger"
        icon="log-out-outline"
        testID="logout"
        onPress={() => setAsking(true)}
      />
      <Sheet
        visible={asking || pendingLogout !== null}
        title="تسجيل الخروج"
        onClose={() => {
          setAsking(false);
          onCancelLogout();
        }}
        footer={
          <>
            <Button
              label="خروج"
              variant="danger"
              testID="logout-confirm"
              onPress={async () => {
                await onLogout(pendingLogout !== null);
                setAsking(false);
              }}
            />
            <Button
              label="إلغاء"
              variant="ghost"
              onPress={() => {
                setAsking(false);
                onCancelLogout();
              }}
            />
          </>
        }
      >
        {pendingLogout !== null ? (
          <Notice
            kind="warning"
            text={`${pendingLogout} عمليات لم تُرسل بعد إلى المركز. إن خرجت الآن تبقى محفوظة على الهاتف وتُرسل بعد الدخول التالي.`}
          />
        ) : (
          <Text>ستحتاج رقمك السري للدخول مجدداً.</Text>
        )}
      </Sheet>
    </Screen>
  );
}
