// Returns (FR-18): kind → party → source invoice → returned kg per line → reason on one screen, and the list of returns
// with share and cancel. Every figure of the valuation comes from the use-case after saving.
import { useState } from "react";
import { View } from "react-native";
import { Text } from "./Text";
import {
  RETURN_PROBLEM_TEXT,
  RETURN_REASON_LABEL,
  returnProblems,
  type ReturnDraft,
  type ReturnKind,
  type ReturnListRow,
  type ReturnReason,
  type SourceInvoiceRow,
} from "../core/returns";
import { kg, money } from "./format";
import { MoneyInput } from "./MoneyInput";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { spacing } from "./theme";
import { useColors } from "./themeContext-core";
import {
  Badge,
  Button,
  Chips,
  ConfirmSheet,
  EmptyState,
  ListRow,
  Notice,
  Screen,
  Section,
} from "./kit";

export const RETURN_KIND_LABEL: Record<string, string> = {
  sale: "مرتجع بيع",
  entry: "مرتجع دخول",
};

export function ReturnFormView({
  draft,
  invoices,
  error,
  onKind,
  onParty,
  onInvoice,
  onQty,
  onReason,
  onSave,
}: {
  draft: ReturnDraft;
  invoices: SourceInvoiceRow[];
  error: string | null;
  onKind(k: ReturnKind): void;
  onParty(p: PickedParty): void;
  onInvoice(i: SourceInvoiceRow): void;
  onQty(rollId: string, patch: { kg?: number; pieces?: number }): void;
  onReason(r: ReturnReason): void;
  onSave(): Promise<void> | void;
}) {
  const colors = useColors();
  const [attempted, setAttempted] = useState(false);
  const problems = returnProblems(draft);
  return (
    <Screen
      title="مرتجع جديد"
      subtitle={RETURN_KIND_LABEL[draft.kind]}
      footer={
        <Button
          label="حفظ المرتجع"
          busyLabel="جارٍ الحفظ…"
          testID="return-save"
          onPress={async () => {
            setAttempted(true);
            if (problems.length === 0) await onSave();
          }}
        />
      }
    >
      <Chips<ReturnKind>
        options={[
          { value: "sale", label: "مرتجع بيع (من عميل)" },
          { value: "entry", label: "مرتجع دخول (إلى مورد)" },
        ]}
        value={draft.kind}
        onChange={onKind}
        testIDPrefix="return-kind"
      />
      <Section>
        <PartyPicker
          key={draft.kind}
          kind={draft.kind === "sale" ? "customer" : "supplier"}
          value={draft.party}
          onPick={onParty}
          error={attempted && !draft.party}
        />
      </Section>
      {draft.party ? (
        <Section title="الفاتورة الأصلية" padded={false}>
          {invoices.length === 0 ? (
            <View testID="no-invoices" style={{ padding: spacing.lg }}>
              <Text style={{ color: colors.mutedForeground }}>لا فواتير لهذا الطرف</Text>
            </View>
          ) : (
            invoices.map((i, idx) => {
              const chosen = draft.invoice?.id === i.id;
              return (
                <ListRow
                  key={i.id}
                  testID="source-invoice"
                  accessibilityLabel={`فاتورة ${i.number}`}
                  title={`فاتورة ${i.number}`}
                  subtitle={i.date}
                  value={
                    chosen ? <Badge label="مختارة" tone="positive" /> : money(i.total, i.currency)
                  }
                  onPress={() => onInvoice(i)}
                  last={idx === invoices.length - 1}
                />
              );
            })
          )}
        </Section>
      ) : null}
      {draft.invoice
        ? draft.lines.map((l) => (
            <Section key={l.rollId} testID="return-line">
              <Text style={{ fontWeight: "700" }}>{l.label}</Text>
              <Text style={{ color: colors.mutedForeground }}>
                {`المباع ${kg(l.soldKg)} · السعر ${money(l.pricePerKg, draft.currency)}`}
              </Text>
              <MoneyInput
                label="الكمية المرتجعة (كغ)"
                fieldId={`ret-kg-${l.rollId}`}
                onChangeAmount={(v) => onQty(l.rollId, { kg: v ?? 0 })}
              />
              <MoneyInput
                label="عدد الأثواب (يمكن 0)"
                fieldId={`ret-pcs-${l.rollId}`}
                onChangeAmount={(v) => onQty(l.rollId, { pieces: Math.round(v ?? 0) })}
              />
            </Section>
          ))
        : null}
      <Section title="السبب">
        <Chips<ReturnReason>
          options={(Object.keys(RETURN_REASON_LABEL) as ReturnReason[]).map((r) => ({
            value: r,
            label: RETURN_REASON_LABEL[r],
          }))}
          value={draft.reason}
          onChange={onReason}
          testIDPrefix="return-reason"
        />
      </Section>
      {attempted && problems.length > 0 ? (
        <Notice
          kind="error"
          text={problems.map((p) => RETURN_PROBLEM_TEXT[p]).join("\n")}
          testID="return-problems"
        />
      ) : null}
      {error ? <Notice kind="error" text={error} testID="return-error" /> : null}
    </Screen>
  );
}

export function ReturnListView({
  rows,
  canCancel,
  error,
  onCancel,
  onNew,
  sendSlot,
}: {
  rows: ReturnListRow[] | undefined;
  canCancel: boolean;
  error: string | null;
  onCancel(row: ReturnListRow): Promise<void> | void;
  onNew?: () => void;
  sendSlot?(row: ReturnListRow): React.ReactNode;
}) {
  const [confirming, setConfirming] = useState<ReturnListRow | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = rows ?? [];
  return (
    <Screen title="المرتجعات" subtitle={rows ? `${list.length} مرتجع` : null}>
      {error ? <Notice kind="error" text={error} testID="returns-error" /> : null}
      {list.length === 0 ? (
        <View testID="returns-empty">
          <EmptyState
            title="لا مرتجعات"
            {...(onNew ? { action: { label: "مرتجع جديد", onPress: onNew } } : {})}
          />
        </View>
      ) : (
        <Section padded={false}>
          {list.map((r, i) => (
            <View key={r.id}>
              <ListRow
                testID="return-row"
                accessibilityLabel={`${RETURN_KIND_LABEL[r.kind]} ${r.number}`}
                title={`${RETURN_KIND_LABEL[r.kind]} ${r.number}`}
                subtitle={r.date}
                meta={r.status === "cancelled" ? "ملغى" : null}
                value={money(r.total, r.currency)}
                onPress={() => setOpen(open === r.id ? null : r.id)}
                last={i === list.length - 1 && open !== r.id}
              />
              {open === r.id ? (
                <View style={{ padding: spacing.md, gap: spacing.sm }}>
                  {sendSlot ? sendSlot(r) : null}
                  {r.status !== "cancelled" && canCancel ? (
                    <Button
                      label={`إلغاء المرتجع ${r.number}`}
                      variant="danger"
                      onPress={() => setConfirming(r)}
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
          ))}
        </Section>
      )}
      <ConfirmSheet
        visible={confirming !== null}
        title="إلغاء المرتجع"
        message={
          confirming
            ? `سيُلغى المرتجع ${confirming.number}: يعود المخزون والرصيد كما كانا قبله. لا يمكن التراجع عن الإلغاء.`
            : ""
        }
        confirmLabel="إلغاء المرتجع"
        onCancel={() => setConfirming(null)}
        onConfirm={async () => {
          if (confirming) await onCancel(confirming);
          setConfirming(null);
        }}
      />
    </Screen>
  );
}
