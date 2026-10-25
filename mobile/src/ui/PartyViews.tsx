// Party screens' views (UX-01 card lists): list with search + kind filter, detail with balances, full statement, form.
import { FlatList, Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import type { StatementEntryData } from "@backend/domain/entities/Statement";
import { canWriteOffline, type Role } from "../core/roles";
import type { PartyRow } from "../core/partyQueries";
import { Field } from "./Field";
import { MoneyText } from "./MoneyText";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export type KindFilter = "" | "customer" | "supplier";

const KIND_LABEL: Record<KindFilter, string> = {
  "": "الكل",
  customer: "العملاء",
  supplier: "الموردون",
};

export function PartyListView({
  rows,
  q,
  kind,
  role,
  onQuery,
  onKind,
  onOpen,
  onNew,
}: {
  rows: PartyRow[];
  q: string;
  kind: KindFilter;
  role: Role;
  onQuery(q: string): void;
  onKind(kind: KindFilter): void;
  onOpen(id: string): void;
  onNew(): void;
}) {
  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <Field
        label="بحث"
        fieldId="party-search"
        value={q}
        onChangeText={onQuery}
        placeholder="الاسم أو الرمز أو الهاتف"
      />
      <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md }}>
        {(["", "customer", "supplier"] as KindFilter[]).map((k) => (
          <Pressable
            key={k || "all"}
            accessibilityRole="button"
            accessibilityState={{ selected: kind === k }}
            onPress={() => onKind(k)}
            style={{
              minHeight: TOUCH_TARGET,
              justifyContent: "center",
              paddingHorizontal: spacing.lg,
              borderRadius: radius.xl,
              backgroundColor: kind === k ? colors.primary : colors.muted,
            }}
          >
            <Text style={{ color: kind === k ? colors.primaryForeground : colors.foreground }}>
              {KIND_LABEL[k]}
            </Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpen(item.id)}
            style={{
              minHeight: TOUCH_TARGET,
              padding: spacing.lg,
              marginBottom: spacing.sm,
              backgroundColor: colors.card,
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ fontSize: fontSize.body }}>{item.name}</Text>
            <Text style={{ color: colors.mutedForeground }}>
              {item.kind === "supplier" ? "مورد" : "عميل"}
              {item.code ? ` · ${String(item.code)}` : ""}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text>لا نتائج</Text>}
      />
      {canWriteOffline(role) ? <PrimaryActionBar label="طرف جديد" onPress={onNew} /> : null}
    </View>
  );
}

export interface PartyDetail {
  id: string;
  name: string;
  kind: "customer" | "supplier";
  phone?: string | null;
  balances: Record<string, number>;
  invoices: Array<{ id: string; number: string; date: string; total: number; currency: string }>;
}

export function PartyDetailView({
  party,
  role,
  onStatement,
  onEdit,
  onInvoice,
}: {
  party: PartyDetail;
  role: Role;
  onStatement(): void;
  onEdit(): void;
  onInvoice(id: string): void;
}) {
  const currencies = Object.keys(party.balances).sort();
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.title }}>{party.name}</Text>
      {party.phone ? <Text testID="party-phone">{party.phone}</Text> : null}
      {currencies.map((c) => (
        <View key={c} testID={`balance-${c}`} style={{ marginTop: spacing.md }}>
          <Text style={{ color: colors.mutedForeground }}>{`الرصيد — ${c}`}</Text>
          <MoneyText amount={party.balances[c] ?? 0} currency={c} />
        </View>
      ))}
      <Text style={{ marginTop: spacing.lg, color: colors.mutedForeground }}>آخر المستندات</Text>
      {party.invoices.map((i) => (
        <Pressable
          key={i.id}
          onPress={() => onInvoice(i.id)}
          style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }}
        >
          <Text>{`${i.number} · ${i.date} · ${i.total} ${i.currency}`}</Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="كشف الحساب"
        onPress={onStatement}
        style={{
          minHeight: TOUCH_TARGET,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: colors.primary,
          borderRadius: radius.md,
          marginTop: spacing.lg,
        }}
      >
        <Text style={{ color: colors.primaryForeground }}>كشف الحساب</Text>
      </Pressable>
      {canWriteOffline(role) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="تعديل"
          onPress={onEdit}
          style={{ minHeight: TOUCH_TARGET, justifyContent: "center", alignItems: "center" }}
        >
          <Text>تعديل</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

export function StatementView({
  entries,
  closing,
  onAmend,
}: {
  entries: StatementEntryData[];
  closing: number;
  /** Given only to roles that may write: lets a voucher row be amended (FR-21). */
  onAmend?: (entry: StatementEntryData) => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <Text
        testID="statement-count"
        style={{ padding: spacing.md }}
      >{`${entries.length} حركة`}</Text>
      <FlatList
        testID="statement-list"
        style={{ flex: 1 }}
        data={entries}
        keyExtractor={(e) => e.id}
        initialNumToRender={20}
        windowSize={7}
        renderItem={({ item }) => (
          <View
            style={{
              padding: spacing.md,
              borderBottomWidth: 1,
              borderColor: colors.border,
              opacity: item.status === "cancelled" ? 0.5 : 1,
            }}
          >
            <Text
              style={{ textDecorationLine: item.status === "cancelled" ? "line-through" : "none" }}
            >
              {`${item.date} · ${item.referenceNumber ?? item.type}`}
            </Text>
            <Text>{`مدين ${item.debit} · دائن ${item.credit}`}</Text>
            <MoneyText amount={item.runningBalance} currency={item.currency} />
            {onAmend &&
            item.status === "active" &&
            item.referenceId &&
            (item.type === "receipt_in" || item.type === "payment_out") ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="تعديل"
                onPress={() => onAmend(item)}
                style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }}
              >
                <Text style={{ color: colors.primary }}>تعديل</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      />
      <Text
        testID="statement-closing"
        style={{ padding: spacing.md }}
      >{`الرصيد الختامي: ${closing}`}</Text>
    </View>
  );
}

export const NAME_HINT = "استخدم صيغة: الاسم — المدينة";

/** A duplicate-name refusal from the use-case gets the format hint appended (E12). */
export function withNameHint(error: string): string {
  return /مستخدم مسبقاً|مكرر/.test(error) ? `${error}\n${NAME_HINT}` : error;
}

export interface PartyFormValues {
  name: string;
  phone: string;
  city: string;
}

export function PartyFormView({
  values,
  error,
  busy,
  onChange,
  onSave,
}: {
  values: PartyFormValues;
  error: string | null;
  busy: boolean;
  onChange(patch: Partial<PartyFormValues>): void;
  onSave(): void;
}) {
  return (
    <View style={{ flex: 1, padding: spacing.lg, paddingTop: spacing.xl }}>
      <Field
        label="الاسم"
        fieldId="party-name"
        value={values.name}
        onChangeText={(name) => onChange({ name })}
      />
      <Field
        label="الهاتف"
        fieldId="party-phone"
        value={values.phone}
        keyboardType="phone-pad"
        onChangeText={(phone) => onChange({ phone })}
      />
      <Field
        label="المدينة"
        fieldId="party-city"
        value={values.city}
        onChangeText={(city) => onChange({ city })}
      />
      {error ? (
        <Text testID="party-form-error" style={{ color: colors.negative }}>
          {withNameHint(error)}
        </Text>
      ) : null}
      <PrimaryActionBar
        label={busy ? "جارٍ الحفظ…" : "حفظ"}
        disabled={busy || !values.name.trim()}
        onPress={onSave}
      />
    </View>
  );
}
