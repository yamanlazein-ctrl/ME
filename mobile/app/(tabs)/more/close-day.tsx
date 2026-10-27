import { useState } from "react";
import { Alert, Pressable, ScrollView } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../src/core/appRuntime";
import { cashboxBalances } from "../../../src/core/cashbox";
import { isAdminLike } from "../../../src/core/roles";
import { queryKeys } from "../../../src/hooks/queryKeys";
import { useFinishWrite } from "../../../src/hooks/useFinishWrite";
import { useRole } from "../../../src/hooks/useRole";
import { Field } from "../../../src/ui/Field";
import { MoneyInput } from "../../../src/ui/MoneyInput";
import { MoneyText } from "../../../src/ui/MoneyText";
import { Text } from "../../../src/ui/Text";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "../../../src/ui/theme";

export default function CloseDay() {
  const role = useRole();
  const finish = useFinishWrite();
  const [date, setDate] = useState(localDateISO(new Date()));
  const [currency, setCurrency] = useState("USD");
  const [counted, setCounted] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: [...queryKeys.cashbox, "close", date],
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? cashboxBalances(app.phone, date) : ({} as Record<string, number>);
    },
  });
  if (!isAdminLike(role)) {
    return <Text testID="close-day-denied">إقفال اليوم متاح للمدير والمحاسب فقط</Text>;
  }
  const close = async () => {
    if (counted === null) return;
    setError(null);
    setNotice(null);
    const app = await getApp();
    if (!app.phone) return;
    const r = await app.phone.documents.closeCashboxDay({ date, counted, currency });
    if (!r.ok) return setError(r.error);
    await finish();
    setNotice(`تم إقفال يوم ${date}`);
  };
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>إقفال اليوم</Text>
      <Field label="التاريخ" fieldId="close-date" value={date} onChangeText={setDate} />
      {(["USD", "SYP"] as const).map((c) => (
        <Pressable
          key={c}
          accessibilityRole="button"
          accessibilityLabel={`العملة ${c}`}
          accessibilityState={{ selected: currency === c }}
          onPress={() => setCurrency(c)}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            paddingHorizontal: spacing.lg,
            marginBottom: spacing.sm,
            borderRadius: radius.md,
            backgroundColor: currency === c ? colors.primary : colors.muted,
          }}
        >
          <Text style={{ color: currency === c ? colors.primaryForeground : colors.foreground }}>
            {`${c} — رصيد النظام`}
          </Text>
          <MoneyText amount={data?.[c] ?? 0} currency={c} />
        </Pressable>
      ))}
      <MoneyInput label="المبلغ المعدود" fieldId="close-counted" onChangeAmount={setCounted} />
      {error ? (
        <Text testID="close-error" style={{ color: colors.negative }}>
          {error}
        </Text>
      ) : null}
      {notice ? <Text testID="close-notice">{notice}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="إقفال اليوم"
        disabled={counted === null}
        onPress={() =>
          Alert.alert("إقفال اليوم", `هل تريد إقفال يوم ${date}؟ لا يمكن التراجع.`, [
            { text: "رجوع", style: "cancel" },
            { text: "إقفال", style: "destructive", onPress: () => void close() },
          ])
        }
        style={{
          minHeight: TOUCH_TARGET,
          justifyContent: "center",
          alignItems: "center",
          marginTop: spacing.md,
          borderRadius: radius.md,
          backgroundColor: counted === null ? colors.muted : colors.primary,
        }}
      >
        <Text
          style={{ color: counted === null ? colors.mutedForeground : colors.primaryForeground }}
        >
          إقفال اليوم
        </Text>
      </Pressable>
    </ScrollView>
  );
}
