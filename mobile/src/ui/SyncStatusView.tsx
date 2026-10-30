// Read-only sync screen (FR-37, E5): what waits to be sent, the last run and its error, and rejected or stopped documents
// with the instruction to resolve them on the desktop. There is deliberately no requeue/retry control for them.
import type { SyncStatus } from "../core/syncRunner";
import { KeyValue, ListRow, Notice, Screen, Section } from "./kit";

export const DESKTOP_ONLY_TEXT = "يجب الحل من الديسكتوب";

export function SyncStatusView({ status, pending }: { status: SyncStatus; pending: number }) {
  return (
    <Screen title="حالة المزامنة" subtitle="ما أُرسل إلى المركز وما ينتظر">
      <Section>
        <KeyValue
          label="بانتظار الإرسال"
          value={`بانتظار الإرسال: ${pending}`}
          testID="pending-count"
        />
        <KeyValue
          label="آخر تشغيل"
          value={`آخر تشغيل: ${status.lastRunAt ?? "—"}`}
          testID="last-run"
        />
      </Section>
      {pending === 0 &&
      !status.lastError &&
      status.rejected.length === 0 &&
      status.hubDeadOps.length === 0 ? (
        <Notice kind="success" text="كل ما على الهاتف أُرسل إلى المركز." />
      ) : null}
      {status.lastError ? (
        <Notice kind="error" text={`آخر خطأ: ${status.lastError}`} testID="last-error" />
      ) : null}
      {status.rejected.length > 0 || status.hubDeadOps.length > 0 ? (
        <Section title="مستندات تحتاج حلاً من الحاسوب" padded={false}>
          {status.rejected.map((r) => (
            <ListRow
              key={r.opId}
              testID="rejected-doc"
              title={`مستند مرفوض: ${r.number ?? r.entityType}`}
              subtitle={r.reason ?? null}
              meta={DESKTOP_ONLY_TEXT}
            />
          ))}
          {status.hubDeadOps.map((id, i) => (
            <ListRow
              key={id}
              testID="dead-doc"
              title={`عملية متوقفة: ${id}`}
              meta={DESKTOP_ONLY_TEXT}
              last={i === status.hubDeadOps.length - 1}
            />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
