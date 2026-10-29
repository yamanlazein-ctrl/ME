// Inventory (FR-24..FR-26) on the desktop's model and words: fabric → colour → dye lot (صبغة) with its pieces (أثواب).
// The list answers "what do I have" at a glance; each level opens the next; a lot shows its quantities, specs, source,
// prices and every stock movement with the balance after it.
import { useState } from "react";
import { FlatList, View } from "react-native";
import { Text } from "./Text";
import { isAdminLike, type Role } from "../core/roles";
import type { CountLineRow } from "../core/inventory";
import {
  LOT_STATE_LABEL,
  type ColorLots,
  type FabricDetail,
  type FabricStock,
  type LotDetail,
  type LotMatch,
  type LotState,
  type StockFilter,
} from "../core/stock";
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { kg, money, piecesText } from "./format";
import { radius, spacing } from "./theme";
import { useColors } from "./themeContext-core";
import {
  Badge,
  Button,
  Chips,
  EmptyState,
  ErrorState,
  HeaderIcon,
  KeyValue,
  ListRow,
  LoadingState,
  Notice,
  Screen,
  SearchBar,
  Section,
} from "./kit";

export const DEFAULT_ADJUST_REASON = "تعديل يدوي";
export const LOW_STOCK_TEXT = "مخزون منخفض";

const STATE_TONE: Record<LotState, "positive" | "warning" | "negative"> = {
  active: "positive",
  low: "warning",
  out: "negative",
};

export function LotBadge({ state }: { state: LotState }) {
  return <Badge label={LOT_STATE_LABEL[state]} tone={STATE_TONE[state]} />;
}

function Swatch({ hex }: { hex: string | null }) {
  const colors = useColors();
  if (!hex) return null;
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: 28,
        height: 28,
        borderRadius: radius.sm,
        backgroundColor: hex,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    />
  );
}

const FILTERS: Array<{ value: StockFilter; label: string }> = [
  { value: "all", label: "الكل" },
  { value: "inStock", label: "متوفر" },
  { value: "low", label: "منخفض" },
  { value: "out", label: "نفد" },
];

export interface StockListProps {
  q: string;
  filter: StockFilter;
  category: string | null;
  categories: string[];
  rows: FabricStock[] | undefined;
  lots: LotMatch[];
  loading: boolean;
  error: unknown;
  refreshing: boolean;
  canCount: boolean;
  onQuery(q: string): void;
  onFilter(f: StockFilter): void;
  onCategory(c: string | null): void;
  onRefresh(): void;
  onRetry(): void;
  onOpenFabric(id: string): void;
  onOpenLot(id: string): void;
  onCount(): void;
}

/** The inventory tab: one search, state and category filters, fabrics with their totals, and direct lot matches. */
export function StockListView(p: StockListProps) {
  const colors = useColors();
  const rows = p.rows ?? [];
  const total = rows.reduce((s, r) => s + r.remainingKg, 0);
  return (
    <Screen
      title="المخزون"
      subtitle={p.rows ? `${rows.length} قماش · ${kg(total)}` : null}
      back={false}
      headerActions={
        p.canCount ? (
          <HeaderIcon
            icon="clipboard-outline"
            label="جرد المخزون"
            onPress={p.onCount}
            testID="open-count"
          />
        ) : null
      }
      refreshing={p.refreshing}
      onRefresh={p.onRefresh}
    >
      <SearchBar
        value={p.q}
        onChange={p.onQuery}
        placeholder="ابحث بالقماش، اللون، رقم اللون أو رقم الصبغة"
        testID="stock-search"
      />
      <Chips options={FILTERS} value={p.filter} onChange={p.onFilter} testIDPrefix="stock-filter" />
      {p.categories.length > 0 ? (
        <Chips
          options={[
            { value: "", label: "كل الفئات" },
            ...p.categories.map((c) => ({ value: c, label: c })),
          ]}
          value={p.category ?? ""}
          onChange={(c) => p.onCategory(c || null)}
          testIDPrefix="stock-category"
        />
      ) : null}
      {p.lots.length > 0 ? (
        <Section title="صبغات مطابقة" padded={false}>
          {p.lots.map((l, i) => (
            <ListRow
              key={l.id}
              testID={`lot-match-${l.rollNo}`}
              title={`صبغة ${l.rollNo}`}
              subtitle={`${l.fabricName} · ${l.colorName}`}
              value={kg(l.remainingKg)}
              valueCaption={piecesText(l.remainingPieces)}
              onPress={() => p.onOpenLot(l.id)}
              last={i === p.lots.length - 1}
            />
          ))}
        </Section>
      ) : null}
      {p.error && !p.rows ? (
        <ErrorState message="تعذّر تحميل المخزون من قاعدة الهاتف." onRetry={p.onRetry} />
      ) : p.loading && !p.rows ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="cube-outline"
          title={p.q || p.filter !== "all" || p.category ? "لا نتائج مطابقة" : "لا أقمشة بعد"}
          hint={
            p.q || p.filter !== "all" || p.category
              ? "غيّر البحث أو الفلتر."
              : "تُضاف الأقمشة من فاتورة شراء أو من برنامج الحاسوب."
          }
        />
      ) : (
        <Section title="الأقمشة" padded={false} testID="fabric-list">
          {rows.map((f, i) => (
            <ListRow
              key={f.id}
              testID="fabric-row"
              accessibilityLabel={f.name}
              title={f.name}
              subtitle={[f.category, `${f.colorCount} لون`, `${f.activeLots} صبغة متوفرة`]
                .filter(Boolean)
                .join(" · ")}
              value={
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <Text
                    style={{
                      fontWeight: "700",
                      color: f.remainingKg <= 0 ? colors.negative : colors.foreground,
                    }}
                  >
                    {kg(f.remainingKg)}
                  </Text>
                  {f.remainingKg <= 0 ? (
                    <Badge label="نفد" tone="negative" />
                  ) : f.low ? (
                    <Badge label={LOW_STOCK_TEXT} tone="warning" />
                  ) : null}
                </View>
              }
              valueCaption={piecesText(f.pieces)}
              onPress={() => p.onOpenFabric(f.id)}
              last={i === rows.length - 1}
            />
          ))}
        </Section>
      )}
    </Screen>
  );
}

/** One fabric: its totals and minimum, then its colours with their stock. */
export function FabricView({
  detail,
  onOpenColor,
}: {
  detail: FabricDetail;
  onOpenColor(id: string): void;
}) {
  const f = detail.fabric;
  return (
    <Screen title={f.name} subtitle={f.category}>
      <Section title="الرصيد" testID="fabric-summary">
        <KeyValue label="الكمية المتبقية" value={kg(f.remainingKg)} strong />
        <KeyValue label="الأثواب المتبقية" value={String(f.pieces)} />
        <KeyValue label="الصبغات المتوفرة" value={String(f.activeLots)} />
        <KeyValue
          label="الحد الأدنى"
          value={f.minStockKg > 0 ? kg(f.minStockKg) : "غير محدد"}
          tone={f.low ? "warning" : undefined}
        />
        {f.low ? <Notice kind="warning" text="الرصيد أقل من الحد الأدنى لهذا القماش." /> : null}
        {f.notes ? <KeyValue label="ملاحظات" value={f.notes} /> : null}
      </Section>
      {detail.colors.length === 0 ? (
        <EmptyState title="لا ألوان لهذا القماش" />
      ) : (
        <Section title={`الألوان (${detail.colors.length})`} padded={false}>
          {detail.colors.map((c, i) => (
            <ListRow
              key={c.id}
              testID="color-row"
              accessibilityLabel={c.name}
              leading={<Swatch hex={c.hex} />}
              title={c.name}
              subtitle={[
                c.code ? `رقم اللون ${c.code}` : null,
                `${c.activeLots} من ${c.totalLots} صبغة متوفرة`,
              ]
                .filter(Boolean)
                .join(" · ")}
              value={kg(c.remainingKg)}
              valueCaption={piecesText(c.pieces)}
              onPress={() => onOpenColor(c.id)}
              last={i === detail.colors.length - 1}
            />
          ))}
        </Section>
      )}
    </Screen>
  );
}

/** The dye lots of one colour, available ones first by default. */
export function ColorLotsView({
  data,
  onOpenLot,
}: {
  data: ColorLots;
  onOpenLot(id: string): void;
}) {
  const [show, setShow] = useState<"available" | "all">("available");
  const lots = show === "available" ? data.lots.filter((l) => l.remainingKg > 0) : data.lots;
  const total = data.lots.reduce((s, l) => s + l.remainingKg, 0);
  return (
    <Screen
      title={`${data.fabricName} · ${data.colorName}`}
      subtitle={`${data.colorCode ? `رقم اللون ${data.colorCode} · ` : ""}${kg(total)}`}
    >
      <Chips<"available" | "all">
        options={[
          {
            value: "available",
            label: `المتوفرة (${data.lots.filter((l) => l.remainingKg > 0).length})`,
          },
          { value: "all", label: `الكل (${data.lots.length})` },
        ]}
        value={show}
        onChange={setShow}
        testIDPrefix="lots-filter"
      />
      {lots.length === 0 ? (
        <EmptyState title="لا صبغات متوفرة لهذا اللون" hint="اختر «الكل» لرؤية الصبغات المنتهية." />
      ) : (
        <Section padded={false}>
          {lots.map((l, i) => (
            <ListRow
              key={l.id}
              testID={`lot-${l.rollNo}`}
              title={`صبغة ${l.rollNo}`}
              subtitle={[l.supplierName, l.entryDate].filter(Boolean).join(" · ") || null}
              meta={l.dyeBatch ? `رقم الصبغة ${l.dyeBatch}` : null}
              value={
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <Text style={{ fontWeight: "700" }}>{kg(l.remainingKg)}</Text>
                  <LotBadge state={l.state} />
                </View>
              }
              valueCaption={`من ${kg(l.initialKg)} · ${piecesText(l.remainingPieces)}`}
              onPress={() => onOpenLot(l.id)}
              last={i === lots.length - 1}
            />
          ))}
        </Section>
      )}
    </Screen>
  );
}

export interface LotViewProps {
  lot: LotDetail;
  role: Role;
  error: string | null;
  notice: string | null;
  onAdjust(values: { newKg: number; reason: string }): Promise<void>;
  onOpenReference(m: LotDetail["movements"][number]): void;
}

/** One dye lot: quantities, specs, source, prices, movements; admins can correct the remaining quantity. */
export function LotView({ lot, role, error, notice, onAdjust, onOpenReference }: LotViewProps) {
  const colors = useColors();
  const [newKg, setNewKg] = useState<number | null>(null);
  const [reason, setReason] = useState(DEFAULT_ADJUST_REASON);
  const [adjusting, setAdjusting] = useState(false);
  const can = isAdminLike(role);
  return (
    <Screen title={`صبغة ${lot.rollNo}`} subtitle={`${lot.fabricName} · ${lot.colorName}`}>
      {notice ? <Notice kind="success" text={notice} testID="lot-notice" /> : null}
      <Section title="الكمية" testID="lot-quantity">
        <KeyValue label="المتبقي" value={kg(lot.remainingKg)} strong testID="lot-remaining" />
        <KeyValue label="الكمية الأصلية" value={kg(lot.initialKg)} />
        <KeyValue label="الخارج من الصبغة" value={kg(lot.outKg)} />
        <KeyValue label="الأثواب" value={`${lot.remainingPieces} من ${lot.pieces}`} />
        <KeyValue label="الحالة" value={<LotBadge state={lot.state} />} />
      </Section>
      <Section title="المواصفات والمصدر">
        {lot.colorCode ? <KeyValue label="رقم اللون" value={lot.colorCode} /> : null}
        {lot.dyeBatch ? <KeyValue label="رقم الصبغة" value={lot.dyeBatch} /> : null}
        {lot.widthCm !== null ? <KeyValue label="العرض" value={`${lot.widthCm} سم`} /> : null}
        {lot.weightGsm !== null ? <KeyValue label="الوزن" value={`${lot.weightGsm} غ/م²`} /> : null}
        <KeyValue label="المورد" value={lot.supplierName ?? "—"} />
        <KeyValue label="تاريخ الدخول" value={lot.entryDate ?? "—"} />
        {lot.entryReference ? <KeyValue label="مرجع الإدخال" value={lot.entryReference} /> : null}
      </Section>
      <Section title="الأسعار">
        <KeyValue label="التكلفة للكيلو" value={money(lot.costPerKg, lot.currency)} />
        {lot.salePricePerKg !== null ? (
          <KeyValue label="سعر البيع للكيلو" value={money(lot.salePricePerKg, lot.currency)} />
        ) : null}
        {lot.entryPricePerKg !== null && lot.entryCurrency ? (
          <KeyValue
            label="سعر الشراء الأصلي"
            value={money(lot.entryPricePerKg, lot.entryCurrency)}
          />
        ) : null}
      </Section>
      <Section
        title={`حركات المخزون (${lot.movements.length})`}
        padded={false}
        testID="lot-movements"
      >
        {lot.movements.length === 0 ? (
          <View style={{ padding: spacing.lg }}>
            <Text style={{ color: colors.mutedForeground }}>لا حركات بعد</Text>
          </View>
        ) : (
          lot.movements.map((m, i) => (
            <ListRow
              key={m.id}
              testID="movement-row"
              title={m.label}
              subtitle={[m.date, m.reference].filter(Boolean).join(" · ")}
              meta={m.cancelled ? "ملغاة" : null}
              value={
                <Text
                  style={{
                    fontWeight: "700",
                    color: m.direction === "in" ? colors.positive : colors.negative,
                  }}
                >
                  {`${m.direction === "in" ? "+" : "−"}${kg(m.quantityKg)}`}
                </Text>
              }
              valueCaption={`الرصيد ${kg(m.balanceAfterKg)}`}
              {...(m.referenceId && m.referenceType === "invoice"
                ? { onPress: () => onOpenReference(m) }
                : {})}
              last={i === lot.movements.length - 1}
            />
          ))
        )}
      </Section>
      {can ? (
        adjusting ? (
          <Section title="تعديل الكمية المتبقية" testID="lot-adjust">
            <Notice
              kind="info"
              text="يُسجَّل الفرق حركة «تعديل يدوي» على الصبغة. استخدمه لتصحيح وزن فعلي، لا للبيع."
            />
            <MoneyInput
              label="الكمية الصحيحة الآن (كغ)"
              fieldId="adjust-kg"
              onChangeAmount={setNewKg}
            />
            <Field
              label="سبب التعديل"
              fieldId="adjust-reason"
              value={reason}
              onChangeText={setReason}
            />
            {error ? <Notice kind="error" text={error} testID="roll-error" /> : null}
            <Button
              label="حفظ التعديل"
              busyLabel="جارٍ الحفظ…"
              disabled={newKg === null || reason.trim().length < 2}
              onPress={async () => {
                if (newKg === null) return;
                await onAdjust({ newKg, reason: reason.trim() });
              }}
              testID="adjust-save"
            />
            <Button label="إلغاء" variant="ghost" onPress={() => setAdjusting(false)} />
          </Section>
        ) : (
          <Button
            label="تعديل الكمية"
            variant="secondary"
            icon="create-outline"
            onPress={() => setAdjusting(true)}
            testID="adjust-open"
          />
        )
      ) : null}
    </Screen>
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
  onRecord(line: CountLineRow, countedKg: number): Promise<void> | void;
  onPost(line: CountLineRow): Promise<void> | void;
}) {
  return (
    <Screen title="جرد المخزون" subtitle={`${total} صبغة في الجرد`} scroll={false}>
      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        <SearchBar
          value={q}
          onChange={onQuery}
          placeholder="ابحث برقم الصبغة أو القماش"
          testID="count-search"
        />
        {error ? <Notice kind="error" text={error} testID="count-error" /> : null}
        {notice ? <Notice kind="success" text={notice} testID="count-notice" /> : null}
      </View>
      <FlatList
        data={lines}
        keyExtractor={(l) => l.rollId}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.xxl,
          gap: spacing.md,
        }}
        renderItem={({ item }) => <CountLine line={item} onRecord={onRecord} onPost={onPost} />}
        ListEmptyComponent={<EmptyState title="لا صبغات مطابقة" />}
      />
    </Screen>
  );
}

function CountLine({
  line,
  onRecord,
  onPost,
}: {
  line: CountLineRow;
  onRecord(line: CountLineRow, countedKg: number): Promise<void> | void;
  onPost(line: CountLineRow): Promise<void> | void;
}) {
  const [counted, setCounted] = useState<number | null>(null);
  const hasVariance =
    line.countId !== null && line.status === "counted" && (line.diffKg ?? 0) !== 0;
  return (
    <Section testID="count-line">
      <Text style={{ fontWeight: "700" }}>{`صبغة ${line.rollNo}`}</Text>
      <Text>{`${line.fabricName} · ${line.colorName}`}</Text>
      <KeyValue label="الرصيد الدفتري" value={kg(line.bookKg)} />
      {line.countedKg !== null ? (
        <>
          <KeyValue label="المعدود" value={kg(line.countedKg)} />
          <KeyValue
            label="الفرق"
            value={kg(line.diffKg ?? 0)}
            tone={(line.diffKg ?? 0) !== 0 ? "warning" : undefined}
          />
        </>
      ) : null}
      <MoneyInput
        label="الكمية المعدودة (كغ)"
        fieldId={`count-${line.rollNo}`}
        onChangeAmount={setCounted}
      />
      <Button
        label={`تسجيل العدّ ${line.rollNo}`}
        busyLabel="جارٍ التسجيل…"
        disabled={counted === null}
        onPress={async () => {
          if (counted !== null) await onRecord(line, counted);
        }}
      />
      {hasVariance ? (
        <Button
          label={`ترحيل الفرق ${line.rollNo}`}
          variant="secondary"
          onPress={() => onPost(line)}
        />
      ) : null}
    </Section>
  );
}
