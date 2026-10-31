import type { ReactElement, ReactNode } from "react";
import { FlatList, View } from "react-native";
import { radius, spacing } from "../theme";
import { useColors } from "../themeContext-core";

/**
 * A long list drawn as one card (like a padded=false Section) but virtualised: only the rows on screen are rendered, so
 * a statement or stock list with thousands of rows scrolls smoothly. The page's other content goes in `header`; use it
 * inside a `<Screen scroll={false}>`.
 */
export function CardList<T>({
  data,
  keyOf,
  renderRow,
  header,
  title,
  empty,
  footer,
  testID,
  refreshing,
  onRefresh,
}: {
  data: readonly T[];
  keyOf(item: T): string;
  /** `last` drops the row's bottom hairline (the card's own border closes the list). */
  renderRow(item: T, last: boolean): ReactElement;
  header?: ReactNode;
  /** The list's title above the card (as a Section title). */
  title?: ReactNode;
  /** Shown instead of the card when there are no rows. */
  empty?: ReactNode;
  footer?: ReactNode;
  testID?: string;
  /** Pull to refresh (as Screen's). */
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const colors = useColors();
  const n = data.length;
  return (
    <FlatList
      {...(testID ? { testID } : {})}
      data={data}
      keyExtractor={keyOf}
      keyboardShouldPersistTaps="handled"
      {...(onRefresh ? { onRefresh, refreshing: refreshing ?? false } : {})}
      initialNumToRender={20}
      windowSize={11}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      ListHeaderComponent={
        header || title ? (
          <View style={{ gap: spacing.md, marginBottom: spacing.sm }}>
            {header}
            {title}
          </View>
        ) : undefined
      }
      ListEmptyComponent={empty ? <>{empty}</> : undefined}
      ListFooterComponent={
        footer ? <View style={{ marginTop: spacing.md }}>{footer}</View> : undefined
      }
      renderItem={({ item, index }) => {
        const first = index === 0;
        const last = index === n - 1;
        return (
          <View
            style={{
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderLeftWidth: 1,
              borderRightWidth: 1,
              ...(first
                ? {
                    borderTopWidth: 1,
                    borderTopLeftRadius: radius.lg,
                    borderTopRightRadius: radius.lg,
                  }
                : {}),
              ...(last
                ? {
                    borderBottomWidth: 1,
                    borderBottomLeftRadius: radius.lg,
                    borderBottomRightRadius: radius.lg,
                  }
                : {}),
              overflow: "hidden",
            }}
          >
            {renderRow(item, last)}
          </View>
        );
      }}
    />
  );
}
