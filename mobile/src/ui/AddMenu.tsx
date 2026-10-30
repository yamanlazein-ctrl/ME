// The add tab: every document this phone can create, grouped by what it does, each with one line saying what it is for.
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "./themeContext-core";
import { ListRow, Screen, Section } from "./kit";

type Entry = {
  id: string;
  label: string;
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: string;
};

export const ADD_GROUPS: Array<{ title: string; entries: Entry[] }> = [
  {
    title: "البيع والشراء",
    entries: [
      {
        id: "sale",
        label: "فاتورة بيع",
        hint: "بيع من المخزون لعميل",
        icon: "receipt-outline",
        href: "/(tabs)/add/sale",
      },
      {
        id: "entry",
        label: "فاتورة دخول",
        hint: "شراء بضاعة من مورد وإدخالها المخزون",
        icon: "download-outline",
        href: "/(tabs)/add/entry",
      },
      {
        id: "return",
        label: "مرتجع",
        hint: "إرجاع بضاعة من فاتورة بيع أو دخول",
        icon: "return-down-back-outline",
        href: "/(tabs)/add/return",
      },
    ],
  },
  {
    title: "المال",
    entries: [
      {
        id: "receipt",
        label: "سند قبض",
        hint: "استلام مال من عميل",
        icon: "arrow-down-circle-outline",
        href: "/(tabs)/add/receipt",
      },
      {
        id: "payment",
        label: "سند صرف",
        hint: "دفع مال إلى مورد",
        icon: "arrow-up-circle-outline",
        href: "/(tabs)/add/payment",
      },
      {
        id: "expense",
        label: "مصروف",
        hint: "مصروف من الصندوق (نقل، كهرباء…)",
        icon: "wallet-outline",
        href: "/(tabs)/add/expense",
      },
    ],
  },
];

/** Flat list (tests, deep links). */
export const ADD_ENTRIES = ADD_GROUPS.flatMap((g) => g.entries);

export function AddMenu({ onOpen }: { onOpen(href: string): void }) {
  const colors = useColors();
  return (
    <Screen title="إضافة" subtitle="اختر نوع المستند" back={false}>
      {ADD_GROUPS.map((g) => (
        <Section key={g.title} title={g.title} padded={false}>
          {g.entries.map((e, i) => (
            <ListRow
              key={e.id}
              testID={`add-${e.id}`}
              accessibilityLabel={e.label}
              leading={<Ionicons name={e.icon} size={26} color={colors.primary} />}
              title={e.label}
              subtitle={e.hint}
              onPress={() => onOpen(e.href)}
              last={i === g.entries.length - 1}
            />
          ))}
        </Section>
      ))}
    </Screen>
  );
}
