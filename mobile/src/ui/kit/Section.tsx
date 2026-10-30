import type { ReactNode } from "react";
import { View } from "react-native";
import { Text } from "../Text";
import { radius, spacing } from "../theme";
import { useColors } from "../themeContext-core";

/** A titled group on a card surface. Rows inside are separated by hairlines, not by more cards. */
export function Section({
  title,
  action,
  children,
  testID,
  padded = true,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  testID?: string;
  padded?: boolean;
}) {
  const colors = useColors();
  return (
    <View {...(testID ? { testID } : {})} style={{ gap: spacing.sm }}>
      {title || action ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: spacing.xs,
          }}
        >
          {title ? (
            <Text
              accessibilityRole="header"
              style={{ fontSize: 15, fontWeight: "600", color: colors.mutedForeground }}
            >
              {title}
            </Text>
          ) : (
            <View />
          )}
          {action}
        </View>
      ) : null}
      <View
        style={{
          backgroundColor: colors.card,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.border,
          overflow: "hidden",
          ...(padded ? { padding: spacing.lg, gap: spacing.md } : {}),
        }}
      >
        {children}
      </View>
    </View>
  );
}
