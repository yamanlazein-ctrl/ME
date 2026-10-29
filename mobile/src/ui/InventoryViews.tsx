// Inventory screens' views (FR-24, FR-25, FR-26): fabrics with remaining kg and the low-stock badge, a fabric's colours and
// rolls, one roll with its movements and the adjust form, and the count sheet.
import { useState } from "react";
import { FlatList, Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import { isAdminLike, type Role } from "../core/roles";
import type {
  ColorStockRow,
  CountLineRow,
  FabricStockRow,
  RollDetail,
  RollRow,
} from "../core/inventory";
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

/** Pre-filled and editable: a correction always needs a reason, and most are manual corrections. */
export const DEFAULT_ADJUST_REASON = "تعديل يدوي";

export const LOW_STOCK_TEXT = "مخزون منخفض";

export const kg = (n: number): string => `${n.toFixed(2)} كغ`;

function Card({
  children,
  onPress,
  testID,
  label,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  testID?: string;
  label?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      {...(label ? { accessibilityLabel: label } : {})}
      {...(testID ? { testID } : {})}
      onPress={onPress}
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
      {children}
    </Pressable>
  );
}

export function LowStockBadge() {
  return (
    <View
      testID="low-stock-badge"
      style={{
        alignSelf: "flex-start",
        backgroundColor: colors.negative,
        borderRadius: radius.xl,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        marginTop: spacing.xs,
      }}
    >
      <Text style={{ color: colors.primaryForeground, fontSize: fontSize.caption }}>
        {LOW_STOCK_TEXT}
      </Text>
    </View>
  );
}

export function FabricListView({
  rows,
  q,
  role,
  onQuery,
  onOpen,
  onCount,
}: {
  rows: FabricStockRow[];
  q: string;
  role: Role;
  onQuery(q: string): void;
  onOpen(id: string): void;
  onCount(): void;
}) {
  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.headline, marginBottom: spacing.xs }}>المخزون</Text>
      <Text style={{ color: colors.mutedForeground, marginBottom: spacing.lg }}>
        الأقمشة والكميات المتوفرة
      </Text>
      <Field
        label="بحث"
        fieldId="fabric-search"
        value={q}
        onChangeText={onQuery}
        placeholder="اسم القماش"
      />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => (
          <Card onPress={() => onOpen(item.id)}>
            <Text style={{ fontSize: fontSize.body }}>{item.name}</Text>
            <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: spacing.xs }}>
              <Text style={{ color: colors.mutedForeground }}>
                {`${item.rollCount} لفة`}
              </Text>
              <Text style={{ color: colors.foreground, fontSize: fontSize.amount }}>
                {kg(item.remainingKg)}
              </Text>
            </View>
            {item.low ? <LowStockBadge /> : null}
          </Card>
        )}
        ListEmptyComponent={<Text testID="inventory-empty">لا نتائج</Text>}
        contentContainerStyle={{ paddingBottom: 96 }}
      />
      {isAdminLike(role) ? <PrimaryActionBar label="جرد المخزون" onPress={onCount} /> : null}
    </View>
  );
}

export function RollRows({ rolls, onOpen }: { rolls: RollRow[]; onOpen(id: string): void }) {
  if (rolls.length === 0) return <Text style={{ color: colors.mutedForeground }}>لا لفات</Text>;
  return (
    <View>
      {rolls.map((r) => (
        <Pressable
          key={r.id}
          accessibilityRole="button"
          accessibilityLabel={`لفة ${r.rollNo}`}
          testID="roll-row"
          onPress={() => onOpen(r.id)}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            paddingVertical: spacing.sm,
          }}
        >
          <Text>{`${r.rollNo} · ${kg(r.remainingKg)}`}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function FabricDetailView({
  name,
  rows,
  rollsOf,
  onOpenRoll,
}: {
  name: string;
  rows: ColorStockRow[];
  /** Renders the rolls of an expanded colour (the screen owns the query). */
  rollsOf(colorId: string): React.ReactNode;
  onOpenRoll(id: string): void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  void onOpenRoll;
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>{name}</Text>
      {rows.length === 0 ? <Text>لا ألوان</Text> : null}
      {rows.map((c) => (
        <View key={c.id}>
          <Card
            testID="color-row"
            label={`اللون ${c.name}`}
            onPress={() => setOpen(open === c.id ? null : c.id)}
          >
            <Text style={{ fontSize: fontSize.body }}>{c.name}</Text>
            <Text style={{ color: colors.mutedForeground }}>
              {`${kg(c.remainingKg)} · ${c.rollCount} لفة`}
            </Text>
          </Card>
          {open === c.id ? (
            <View style={{ paddingHorizontal: spacing.md }}>{rollsOf(c.id)}</View>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

export interface AdjustValues {
  newKg: number | null;
  reason: string;
}

export function RollDetailView({
  detail,
  role,
  error,
  busy,
  onAdjust,
}: {
  detail: RollDetail;
  role: Role;
  error: string | null;
  busy: boolean;
  onAdjust(values: { newKg: number; reason: string }): void;
}) {
  const [newKg, setNewKg] = useState<number | null>(null);
  const [reason, setReason] = useState(DEFAULT_ADJUST_REASON);
  const r = detail.roll;
  const can = isAdminLike(role);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}>
        <Text style={{ fontSize: fontSize.title }}>{`لفة ${r.rollNo}`}</Text>
        <Text>{`${detail.fabricName} · ${detail.colorName}`}</Text>
        <Text testID="roll-remaining" style={{ marginTop: spacing.md }}>
          {`المتبقي: ${kg(r.remainingKg)} من ${kg(r.initialKg)}`}
        </Text>
        <Text>{`سعر الكيلو: ${r.pricePerKg} ${r.currency}`}</Text>
        <Text>{`تاريخ الإدخال: ${r.entryDate}`}</Text>
        {r.dyeBatch ? <Text>{`دفعة الصباغة: ${r.dyeBatch}`}</Text> : null}
        {can ? (
          <View style={{ marginTop: spacing.xl }}>
            <Text style={{ fontSize: fontSize.body, marginBottom: spacing.sm }}>تعديل الكمية</Text>
            <MoneyInput label="الكمية الجديدة (كغ)" fieldId="adjust-kg" onChangeAmount={setNewKg} />
            <Field
              label="سبب التعديل"
              fieldId="adjust-reason"
              value={reason}
              onChangeText={setReason}
            />
          </View>
        ) : null}
        <Text style={{ marginTop: spacing.lg, color: colors.mutedForeground }}>حركات المخزون</Text>
        {detail.movements.length === 0 ? <Text>لا حركات</Text> : null}
        {detail.movements.map((m) => (
          <Text key={m.id} testID="movement-row">
            {`${m.date} · ${m.reference} · ${m.deltaKg > 0 ? "+" : ""}${m.deltaKg.toFixed(2)} كغ`}
          </Text>
        ))}
        {error ? (
          <Text testID="roll-error" style={{ color: colors.negative, marginTop: spacing.md }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      {can ? (
        <PrimaryActionBar
          label={busy ? "جارٍ الحفظ…" : "حفظ التعديل"}
          disabled={busy || newKg === null || reason.trim().length < 2}
          onPress={() => newKg !== null && onAdjust({ newKg, reason })}
        />
      ) : null}
    </View>
  );
}

export function CountSheetView({
  lines,
  total,
  q,
  error,
  notice,
  onQuery,
  onRecord,
  onPost,
}: {
  lines: CountLineRow[];
  total: number;
  q: string;
  error: string | null;
  notice: string | null;
  onQuery(q: string): void;
  onRecord(line: CountLineRow, countedKg: number): void;
  onPost(line: CountLineRow): void;
}) {
  return (
    <View style={{ flex: 1, padding: spacing.lg }}>
      <Text style={{ fontSize: fontSize.title }}>جرد المخزون</Text>
      <Field label="بحث" fieldId="count-search" value={q} onChangeText={onQuery} />
      <Text style={{ color: colors.mutedForeground }}>{`${total} لفة`}</Text>
      {error ? (
        <Text testID="count-error" style={{ color: colors.negative }}>
          {error}
        </Text>
      ) : null}
      {notice ? <Text testID="count-notice">{notice}</Text> : null}
      <FlatList
        data={lines}
        keyExtractor={(l) => l.rollId}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => <CountLine line={item} onRecord={onRecord} onPost={onPost} />}
        ListEmptyComponent={<Text>لا لفات</Text>}
      />
    </View>
  );
}

function CountLine({
  line,
  onRecord,
  onPost,
}: {
  line: CountLineRow;
  onRecord(line: CountLineRow, countedKg: number): void;
  onPost(line: CountLineRow): void;
}) {
  const [counted, setCounted] = useState<number | null>(null);
  const hasVariance =
    line.countId !== null && line.status === "counted" && (line.diffKg ?? 0) !== 0;
  return (
    <View
      testID="count-line"
      style={{
        padding: spacing.lg,
        marginBottom: spacing.sm,
        backgroundColor: colors.card,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Text>{`${line.rollNo} · ${line.fabricName} · ${line.colorName}`}</Text>
      <Text style={{ color: colors.mutedForeground }}>{`الدفتري: ${kg(line.bookKg)}`}</Text>
      {line.countedKg !== null ? (
        <Text>{`المعدود: ${kg(line.countedKg)} · الفرق: ${(line.diffKg ?? 0).toFixed(2)}`}</Text>
      ) : null}
      <MoneyInput
        label="الكمية المعدودة (كغ)"
        fieldId={`count-${line.rollNo}`}
        onChangeAmount={setCounted}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`تسجيل العدّ ${line.rollNo}`}
        disabled={counted === null}
        onPress={() => counted !== null && onRecord(line, counted)}
        style={{
          minHeight: TOUCH_TARGET,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: counted === null ? colors.muted : colors.primary,
          borderRadius: radius.md,
        }}
      >
        <Text
          style={{ color: counted === null ? colors.mutedForeground : colors.primaryForeground }}
        >
          تسجيل العدّ
        </Text>
      </Pressable>
      {hasVariance ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`ترحيل الفرق ${line.rollNo}`}
          onPress={() => onPost(line)}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            alignItems: "center",
            marginTop: spacing.sm,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radius.md,
          }}
        >
          <Text>ترحيل الفرق</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
