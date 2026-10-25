import { Pressable, Text, View } from "react-native";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export const ADD_ENTRIES = [
  { id: "sale", label: "بيع جديد", href: "/(tabs)/add/sale/customer" },
  { id: "receipt", label: "سند قبض", href: "/(tabs)/add/receipt" },
  { id: "payment", label: "سند دفع", href: "/(tabs)/add/payment" },
  { id: "expense", label: "مصروف", href: "/(tabs)/add/expense" },
] as const;

export function AddMenu({ onOpen }: { onOpen(href: string): void }) {
  return (
    <View style={{ padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.md }}>
      {ADD_ENTRIES.map((e) => (
        <Pressable
          key={e.id}
          accessibilityRole="button"
          accessibilityLabel={e.label}
          onPress={() => onOpen(e.href)}
          style={{
            minHeight: TOUCH_TARGET + 16,
            justifyContent: "center",
            paddingHorizontal: spacing.xl,
            backgroundColor: colors.card,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ fontSize: fontSize.title }}>{e.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
