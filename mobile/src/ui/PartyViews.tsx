// Customers and suppliers (FR-11..FR-14) as the desktop's party page shows them: a searchable list with each party's
// balance per currency, a party page built around its money (balances, documents, statement, the actions it allows),
// and a statement for a period and currency whose lines open their documents.
import { Linking, View } from "react-native";
import { Text } from "./Text";
import type { StatementEntryData } from "@backend/domain/entities/Statement";
import { canWriteOffline, type Role } from "../core/roles";
import {
  balanceSideLabel,
  STATEMENT_TYPE_LABEL,
  type CurrencyBalance,
  type PartyDocKind,
  type PartyDocRow,
  type PartyKind,
  type PartyListRow,
  type PartyProfile,
  type StatementResult,
} from "../core/parties";
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { money } from "./format";
import { formatAmount } from "./money";
import { spacing } from "./theme";
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

export type KindFilter = "" | "customer" | "supplier";

const KIND_OPTIONS: Array<{ value: KindFilter; label: string }> = [
  { value: "", label: "الكل" },
  { value: "customer", label: "العملاء" },
  { value: "supplier", label: "الموردون" },
];

export const KIND_LABEL: Record<PartyKind, string> = { customer: "عميل", supplier: "مورد" };

/** One balance as the desktop says it: amount + currency + side (مدين على العميل…). */
function BalanceText({ b, kind }: { b: CurrencyBalance; kind: PartyKind }) {
  const colors = useColors();
  const tone =
    b.side === "zero"
      ? colors.mutedForeground
      : (kind === "customer") === (b.side === "debit")
        ? colors.foreground
        : colors.positive;
  return (
    <View style={{ alignItems: "flex-end" }}>
      <Text style={{ fontWeight: "700", color: tone, writingDirection: "ltr" }}>
        {money(Math.abs(b.balance), b.currency)}
      </Text>
      <Text style={{ fontSize: 13, color: colors.mutedForeground }}>
        {balanceSideLabel(b.side, kind)}
      </Text>
    </View>
  );
}

export interface PartyListProps {
  rows: PartyListRow[] | undefined;
  balances: Record<string, CurrencyBalance[]>;
  q: string;
  kind: KindFilter;
  role: Role;
  loading: boolean;
  error: unknown;
  refreshing: boolean;
  onQuery(q: string): void;
  onKind(kind: KindFilter): void;
  onOpen(id: string): void;
  onNew(): void;
  onRefresh(): void;
  onRetry(): void;
}

export function PartyListView(p: PartyListProps) {
  const rows = p.rows ?? [];
  const canWrite = canWriteOffline(p.role);
  return (
    <Screen
      title="العملاء والموردون"
      subtitle={p.rows ? `${rows.length} طرف` : null}
      back={false}
      headerActions={
        canWrite ? (
          <HeaderIcon
            icon="person-add-outline"
            label="طرف جديد"
            onPress={p.onNew}
            testID="party-new"
          />
        ) : null
      }
      refreshing={p.refreshing}
      onRefresh={p.onRefresh}
    >
      <SearchBar
        value={p.q}
        onChange={p.onQuery}
        placeholder="الاسم أو الرمز أو رقم الهاتف"
        testID="party-search"
      />
      <Chips options={KIND_OPTIONS} value={p.kind} onChange={p.onKind} testIDPrefix="party-kind" />
      {p.error && !p.rows ? (
        <ErrorState message="تعذّر تحميل الأطراف من قاعدة الهاتف." onRetry={p.onRetry} />
      ) : p.loading && !p.rows ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="people-outline"
          title={p.q ? "لا نتائج مطابقة" : "لا أطراف بعد"}
          {...(canWrite && !p.q ? { action: { label: "طرف جديد", onPress: p.onNew } } : {})}
        />
      ) : (
        <Section padded={false}>
          {rows.map((r, i) => {
            const balances = (p.balances[r.id] ?? []).filter((b) => b.side !== "zero");
            return (
              <ListRow
                key={r.id}
                testID="party-row"
                accessibilityLabel={r.name}
                title={r.name}
                subtitle={[KIND_LABEL[r.kind], r.code, r.city].filter(Boolean).join(" · ")}
                meta={r.phone}
                value={
                  balances.length > 0 ? (
                    <View style={{ gap: 4 }}>
                      {balances.map((b) => (
                        <BalanceText key={b.currency} b={b} kind={r.kind} />
                      ))}
                    </View>
                  ) : p.balances[r.id] ? (
                    <Badge label="متوازن" />
                  ) : undefined
                }
                onPress={() => p.onOpen(r.id)}
                last={i === rows.length - 1}
              />
            );
          })}
        </Section>
      )}
    </Screen>
  );
}

const DOC_TABS: Array<{ value: PartyDocKind; label: string }> = [
  { value: "invoices", label: "الفواتير" },
  { value: "vouchers", label: "السندات" },
  { value: "returns", label: "المرتجعات" },
];

export interface PartyDetailProps {
  party: PartyProfile;
  role: Role;
  tab: PartyDocKind;
  docs: PartyDocRow[] | undefined;
  onTab(tab: PartyDocKind): void;
  onStatement(): void;
  onEdit(): void;
  onOpenDoc(doc: PartyDocRow): void;
  /** Sale (customer) or purchase (supplier) for this party. */
  onNewInvoice(): void;
  /** Receipt (customer) or payment (supplier) for this party. */
  onNewVoucher(): void;
}

export function PartyDetailView(p: PartyDetailProps) {
  const colors = useColors();
  const { party } = p;
  const canWrite = canWriteOffline(p.role);
  const customer = party.kind === "customer";
  const docs = p.docs ?? [];
  return (
    <Screen
      title={party.name}
      subtitle={[KIND_LABEL[party.kind], party.code].filter(Boolean).join(" · ")}
      headerActions={
        canWrite ? (
          <HeaderIcon icon="create-outline" label="تعديل" onPress={p.onEdit} testID="party-edit" />
        ) : null
      }
    >
      <Section title="الرصيد" testID="party-balances">
        {party.balances.length === 0 ? (
          <Text style={{ color: colors.mutedForeground }}>لا حركات بعد — الرصيد صفر.</Text>
        ) : (
          party.balances.map((b) => (
            <View
              key={b.currency}
              testID={`balance-${b.currency}`}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Text style={{ color: colors.mutedForeground }}>{b.currency}</Text>
              <BalanceText b={b} kind={party.kind} />
            </View>
          ))
        )}
        <Button
          label="كشف الحساب"
          icon="document-text-outline"
          onPress={p.onStatement}
          testID="party-statement"
        />
      </Section>
      {canWrite ? (
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Button
              label={customer ? "بيع جديد" : "فاتورة دخول"}
              variant="secondary"
              icon="receipt-outline"
              onPress={p.onNewInvoice}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label={customer ? "سند قبض" : "سند صرف"}
              variant="secondary"
              icon="cash-outline"
              onPress={p.onNewVoucher}
            />
          </View>
        </View>
      ) : null}
      <Section title="بيانات الاتصال">
        {party.phones.length === 0 ? <KeyValue label="الهاتف" value="—" /> : null}
        {party.phones.map((ph) => (
          <View
            key={ph}
            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
          >
            <Text style={{ color: colors.mutedForeground }}>الهاتف</Text>
            <Button
              label={ph}
              variant="ghost"
              icon="call-outline"
              block={false}
              onPress={() => void Linking.openURL(`tel:${ph.replace(/[^\d+]/g, "")}`)}
            />
          </View>
        ))}
        {party.companyName ? <KeyValue label="الشركة" value={party.companyName} /> : null}
        {party.city ? <KeyValue label="المدينة" value={party.city} /> : null}
        {party.address ? <KeyValue label="العنوان" value={party.address} /> : null}
        {party.email ? <KeyValue label="البريد" value={party.email} /> : null}
        {party.currency ? <KeyValue label="عملة التعامل" value={party.currency} /> : null}
        {party.creditLimit ? (
          <KeyValue label="حد الائتمان" value={formatAmount(party.creditLimit)} />
        ) : null}
        {party.notes ? <KeyValue label="ملاحظات" value={party.notes} /> : null}
      </Section>
      <Chips options={DOC_TABS} value={p.tab} onChange={p.onTab} testIDPrefix="party-docs" />
      {!p.docs ? (
        <LoadingState />
      ) : docs.length === 0 ? (
        <EmptyState title="لا مستندات من هذا النوع" />
      ) : (
        <Section padded={false}>
          {docs.map((d, i) => (
            <ListRow
              key={d.id}
              testID="party-doc"
              accessibilityLabel={`${d.title} ${d.number}`}
              title={`${d.title} ${d.number}`}
              subtitle={d.date}
              meta={d.cancelled ? "ملغى" : d.note}
              value={money(d.amount, d.currency)}
              {...(d.kind === "invoice" ? { onPress: () => p.onOpenDoc(d) } : {})}
              last={i === docs.length - 1}
            />
          ))}
        </Section>
      )}
    </Screen>
  );
}

export type PeriodPreset = "all" | "month" | "lastMonth" | "year" | "custom";

export const PERIOD_OPTIONS: Array<{ value: PeriodPreset; label: string }> = [
  { value: "all", label: "كل الفترات" },
  { value: "month", label: "هذا الشهر" },
  { value: "lastMonth", label: "الشهر الماضي" },
  { value: "year", label: "هذه السنة" },
  { value: "custom", label: "فترة محددة" },
];

/** The from/to of a preset, as YYYY-MM-DD, for `today`. */
export function periodRange(
  preset: PeriodPreset,
  today: Date,
): { from: string | null; to: string | null } {
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const y = today.getFullYear();
  const m = today.getMonth();
  if (preset === "month") return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
  if (preset === "lastMonth")
    return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
  if (preset === "year") return { from: `${y}-01-01`, to: `${y}-12-31` };
  return { from: null, to: null };
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StatementViewProps {
  partyName: string;
  kind: PartyKind;
  currencies: string[];
  currency: string;
  period: PeriodPreset;
  from: string;
  to: string;
  data: StatementResult | undefined;
  loading: boolean;
  error: unknown;
  share: React.ReactNode;
  onCurrency(c: string): void;
  onPeriod(p: PeriodPreset): void;
  onDates(patch: { from?: string; to?: string }): void;
  onOpenEntry(e: StatementEntryData): void;
  onRetry(): void;
}

function entryOpens(e: StatementEntryData): boolean {
  return Boolean(e.referenceId) && e.status === "active" && e.type !== "opening";
}

export function StatementView(p: StatementViewProps) {
  const colors = useColors();
  const currencyOptions = [
    { value: "ALL", label: "كل العملات" },
    ...p.currencies.map((c) => ({ value: c, label: c })),
  ];
  const badDates =
    p.period === "custom" &&
    ((p.from !== "" && !DATE_RE.test(p.from)) || (p.to !== "" && !DATE_RE.test(p.to)));
  return (
    <Screen title="كشف الحساب" subtitle={`${p.partyName} · ${KIND_LABEL[p.kind]}`}>
      {p.currencies.length > 1 ? (
        <Chips
          options={currencyOptions}
          value={p.currency}
          onChange={p.onCurrency}
          testIDPrefix="statement-currency"
        />
      ) : null}
      <Chips
        options={PERIOD_OPTIONS}
        value={p.period}
        onChange={p.onPeriod}
        testIDPrefix="statement-period"
      />
      {p.period === "custom" ? (
        <Section>
          <Field
            label="من تاريخ (سنة-شهر-يوم)"
            fieldId="statement-from"
            value={p.from}
            placeholder="2026-01-01"
            keyboardType="numbers-and-punctuation"
            onChangeText={(from) => p.onDates({ from })}
          />
          <Field
            label="إلى تاريخ (سنة-شهر-يوم)"
            fieldId="statement-to"
            value={p.to}
            placeholder="2026-12-31"
            keyboardType="numbers-and-punctuation"
            onChangeText={(to) => p.onDates({ to })}
          />
          {badDates ? <Notice kind="error" text="اكتب التاريخ بالشكل 2026-03-31" /> : null}
        </Section>
      ) : null}
      {p.error && !p.data ? (
        <ErrorState message="تعذّر تحميل الكشف من قاعدة الهاتف." onRetry={p.onRetry} />
      ) : !p.data ? (
        <LoadingState />
      ) : (
        <>
          {p.data.totals.length === 0 ? (
            <EmptyState title="لا حركات في هذه الفترة" />
          ) : (
            p.data.totals.map((t) => (
              <Section
                key={t.currency}
                title={`الملخص — ${t.currency}`}
                testID={`statement-totals-${t.currency}`}
              >
                <KeyValue label="رصيد سابق" value={money(t.previous, t.currency)} />
                <KeyValue label="مدين (الفترة)" value={money(t.debit, t.currency)} />
                <KeyValue label="دائن (الفترة)" value={money(t.credit, t.currency)} />
                <KeyValue
                  label={`الرصيد الختامي — ${balanceSideLabel(t.side, p.kind)}`}
                  value={money(Math.abs(t.closing), t.currency)}
                  strong
                  testID="statement-closing"
                />
              </Section>
            ))
          )}
          {p.share}
          <Section
            title={`الحركات (${p.data.entries.length})`}
            padded={false}
            testID="statement-list"
          >
            {p.data.entries.length === 0 ? (
              <View style={{ padding: spacing.lg }}>
                <Text style={{ color: colors.mutedForeground }}>لا حركات</Text>
              </View>
            ) : (
              p.data.entries.map((e, i) => {
                const debit = Number(e.debit);
                const credit = Number(e.credit);
                const label = STATEMENT_TYPE_LABEL[e.type] ?? e.type;
                return (
                  <ListRow
                    key={e.id}
                    testID="statement-row"
                    accessibilityLabel={`${label} ${e.referenceNumber ?? ""}`.trim()}
                    title={`${label}${e.referenceNumber ? ` ${e.referenceNumber}` : ""}`}
                    subtitle={[e.date, e.description].filter(Boolean).join(" · ")}
                    meta={e.status === "cancelled" ? "ملغاة" : null}
                    value={
                      <Text
                        style={{
                          fontWeight: "700",
                          writingDirection: "ltr",
                          color: debit > 0 ? colors.foreground : colors.positive,
                        }}
                      >
                        {debit > 0 ? `مدين ${formatAmount(debit)}` : `دائن ${formatAmount(credit)}`}
                      </Text>
                    }
                    valueCaption={`الرصيد ${money(e.runningBalance, e.currency)}`}
                    {...(entryOpens(e) ? { onPress: () => p.onOpenEntry(e) } : {})}
                    last={i === p.data!.entries.length - 1}
                  />
                );
              })
            )}
          </Section>
        </>
      )}
    </Screen>
  );
}

export const NAME_HINT = "استخدم صيغة: الاسم — المدينة";

/** A duplicate-name refusal from the use-case gets the format hint appended (E12). */
export function withNameHint(error: string): string {
  return /مستخدم مسبقاً|مكرر/.test(error) ? `${error}\n${NAME_HINT}` : error;
}

export type OpeningDirection = "they_owe_us" | "we_owe_them";

export interface PartyFormValues {
  name: string;
  phone: string;
  city: string;
  /** Opening balance (a new party only): amount, who owes whom, and the currency. */
  openingAmount: number | null;
  openingDirection: OpeningDirection;
  openingCurrency: string;
}

export const emptyPartyForm = (): PartyFormValues => ({
  name: "",
  phone: "",
  city: "",
  openingAmount: null,
  openingDirection: "they_owe_us",
  openingCurrency: "USD",
});

export function PartyFormView({
  title,
  values,
  error,
  showOpening = false,
  onChange,
  onSave,
}: {
  title: string;
  /** The opening-balance fields: a new party saved by admin or accountant. */
  showOpening?: boolean;
  values: PartyFormValues;
  error: string | null;
  onChange(patch: Partial<PartyFormValues>): void;
  onSave(): Promise<void>;
}) {
  return (
    <Screen
      title={title}
      footerNotice={
        <>
          {error ? (
            <Notice kind="error" text={withNameHint(error)} testID="party-form-error" />
          ) : null}
        </>
      }
      footer={
        <Button
          label="حفظ"
          busyLabel="جارٍ الحفظ…"
          disabled={!values.name.trim()}
          onPress={onSave}
          testID="party-save"
        />
      }
    >
      <Section>
        <Field
          label="الاسم"
          fieldId="party-name"
          value={values.name}
          placeholder="الاسم — المدينة"
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
      </Section>
      {showOpening ? (
        <Section title="الرصيد الافتتاحي (اختياري)" testID="opening-section">
          <MoneyInput
            label="المبلغ"
            fieldId="party-opening"
            onChangeAmount={(openingAmount) => onChange({ openingAmount })}
          />
          <Chips<OpeningDirection>
            options={[
              { value: "they_owe_us", label: "عليه لنا" },
              { value: "we_owe_them", label: "له علينا" },
            ]}
            value={values.openingDirection}
            onChange={(openingDirection) => onChange({ openingDirection })}
            testIDPrefix="opening-direction"
          />
          <Chips
            options={[
              { value: "USD", label: "USD" },
              { value: "SYP", label: "SYP" },
            ]}
            value={values.openingCurrency}
            onChange={(openingCurrency) => onChange({ openingCurrency })}
            testIDPrefix="opening-currency"
          />
        </Section>
      ) : null}
    </Screen>
  );
}
