import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../Text";
import { fontSize, spacing, TOUCH_TARGET } from "../theme";
import { useColors } from "../themeContext-core";

/**
 * One row of a list: title + subtitle at the start, a value (amount, quantity, badge) at the end, a chevron when it opens
 * something. Used inside a padded=false Section or a FlatList.
 */
export function ListRow({
  title,
  subtitle,
  meta,
  value,
  valueCaption,
  leading,
  onPress,
  testID,
  accessibilityLabel,
  last = false,
}: {
  title: string;
  subtitle?: string | null;
  /** A third line (dates, codes) in the muted colour. */
  meta?: string | null;
  value?: ReactNode;
  valueCaption?: string | null;
  leading?: ReactNode;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  last?: boolean;
}) {
  const colors = useColors();
  const content = (
    <View
      style={{
        minHeight: TOUCH_TARGET + 16,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: fontSize.body, fontWeight: "600" }} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: colors.mutedForeground, fontSize: 14 }} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
        {meta ? (
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {value !== undefined || valueCaption ? (
        <View style={{ alignItems: "flex-end", gap: 2 }}>
          {typeof value === "string" ? (
            <Text style={{ fontSize: fontSize.body, fontWeight: "700" }}>{value}</Text>
          ) : (
            value
          )}
          {valueCaption ? (
            <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>{valueCaption}</Text>
          ) : null}
        </View>
      ) : null}
      {onPress ? <Ionicons name="chevron-back" size={18} color={colors.mutedForeground} /> : null}
    </View>
  );
  if (!onPress) return <View {...(testID ? { testID } : {})}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      {...(testID ? { testID } : {})}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET,
        backgroundColor: pressed ? colors.muted : "transparent",
      })}
    >
      {content}
    </Pressable>
  );
}

/** A label/value pair, one per line: the label muted at the start, the value at the end. */
export function KeyValue({
  label,
  value,
  strong = false,
  tone,
  testID,
}: {
  label: string;
  value: ReactNode;
  strong?: boolean;
  tone?: "negative" | "positive" | "warning";
  testID?: string;
}) {
  const colors = useColors();
  const color =
    tone === "negative"
      ? colors.negative
      : tone === "positive"
        ? colors.positive
        : tone === "warning"
          ? colors.warning
          : colors.foreground;
  return (
    <View
      {...(testID ? { testID } : {})}
      style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md }}
    >
      <Text style={{ color: colors.mutedForeground, flexShrink: 1 }}>{label}</Text>
      {typeof value === "string" || typeof value === "number" ? (
        <Text style={{ color, fontWeight: strong ? "700" : "400", flexShrink: 1 }}>
          {String(value)}
        </Text>
      ) : (
        value
      )}
    </View>
  );
}

export function Divider() {
  const colors = useColors();
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}
