// Read-only sync screen (FR-37, E5): rejected and dead documents are listed with the instruction to resolve them on the
// desktop. There is deliberately no requeue/retry control for them.
import { ScrollView, View } from "react-native";
import { Text } from "./Text";
import type { SyncStatus } from "../core/syncRunner";
import { fontSize, spacing } from "./theme";
import { useColors } from "./themeContext-core";

export const DESKTOP_ONLY_TEXT = "يجب الحل من الديسكتوب";

export function SyncStatusView({ status, pending }: { status: SyncStatus; pending: number }) {
  const colors = useColors();
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>حالة المزامنة</Text>
      <Text testID="pending-count">{`بانتظار الإرسال: ${pending}`}</Text>
      <Text testID="last-run">{`آخر تشغيل: ${status.lastRunAt ?? "—"}`}</Text>
      {status.lastError ? (
        <Text
          testID="last-error"
          style={{ color: colors.negative }}
        >{`آخر خطأ: ${status.lastError}`}</Text>
      ) : null}
      {status.rejected.map((r) => (
        <View key={r.opId} testID="rejected-doc" style={{ marginTop: spacing.md }}>
          <Text>{`مستند مرفوض: ${r.number ?? r.entityType}`}</Text>
          {r.reason ? <Text>{r.reason}</Text> : null}
          <Text style={{ color: colors.negative }}>{DESKTOP_ONLY_TEXT}</Text>
        </View>
      ))}
      {status.hubDeadOps.map((id) => (
        <View key={id} testID="dead-doc" style={{ marginTop: spacing.md }}>
          <Text>{`عملية متوقفة: ${id}`}</Text>
          <Text style={{ color: colors.negative }}>{DESKTOP_ONLY_TEXT}</Text>
        </View>
      ))}
    </ScrollView>
  );
}
