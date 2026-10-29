import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../Text";
import { fontFamilyFor } from "../fontFamilies";
import { fontSize, radius, spacing, TOUCH_TARGET } from "../theme";
import { useColors } from "../themeContext-core";

export function SearchBar({
  value,
  onChange,
  placeholder = "بحث",
  testID = "search",
}: {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        minHeight: TOUCH_TARGET,
        paddingHorizontal: spacing.md,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.input,
        backgroundColor: colors.card,
      }}
    >
      <Ionicons name="search" size={20} color={colors.mutedForeground} />
      <TextInput
        testID={testID}
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        autoCorrect={false}
        style={{
          flex: 1,
          color: colors.foreground,
          fontSize: fontSize.input,
          fontFamily: fontFamilyFor("400"),
          textAlign: "right",
          paddingVertical: spacing.sm,
        }}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="مسح البحث"
          onPress={() => onChange("")}
          style={{
            minHeight: TOUCH_TARGET,
            minWidth: TOUCH_TARGET,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ionicons name="close-circle" size={20} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

/** One choice out of a few (filters, currency, period). The selected chip is filled and checked — not colour only. */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  testIDPrefix = "chip",
  scroll = false,
}: {
  options: ChipOption<T>[];
  value: T;
  onChange(v: T): void;
  testIDPrefix?: string;
  /** One scrolling line for long, open-ended lists (categories); fixed sets wrap so no choice hides off-screen. */
  scroll?: boolean;
}) {
  const colors = useColors();
  const items = options.map((o) => {
    const on = o.value === value;
    return (
      <Pressable
        key={o.value}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        accessibilityLabel={o.label}
        testID={`${testIDPrefix}-${o.value}`}
        onPress={() => onChange(o.value)}
        style={{
          minHeight: TOUCH_TARGET,
          paddingHorizontal: spacing.md,
          borderRadius: radius.xl,
          borderWidth: 1,
          borderColor: on ? colors.primary : colors.input,
          backgroundColor: on ? colors.primary : colors.card,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        }}
      >
        {on ? <Ionicons name="checkmark" size={16} color={colors.primaryForeground} /> : null}
        <Text style={{ color: on ? colors.primaryForeground : colors.foreground }}>{o.label}</Text>
      </Pressable>
    );
  });
  return scroll ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: spacing.sm }}
    >
      {items}
    </ScrollView>
  ) : (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>{items}</View>
  );
}

/** A small status label with an icon (paid / unpaid / cancelled / low stock…). */
export function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "positive" | "negative" | "warning";
}) {
  const colors = useColors();
  const color = {
    neutral: colors.mutedForeground,
    positive: colors.positive,
    negative: colors.negative,
    warning: colors.warning,
  }[tone];
  return (
    <View
      style={{
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: color,
        paddingHorizontal: spacing.sm,
        paddingVertical: 2,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color, fontSize: 13 }}>{label}</Text>
    </View>
  );
}
