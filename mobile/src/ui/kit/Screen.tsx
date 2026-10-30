import { useEffect, useRef, type ComponentRef, type ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Text } from "../Text";
import { fontSize, spacing, TOUCH_TARGET } from "../theme";
import { useColors } from "../themeContext-core";
import { useHeaderSlot } from "./headerSlot";

export interface ScreenProps {
  title: string;
  subtitle?: string | null;
  /** Show the back button (default: when there is a screen to go back to). */
  back?: boolean;
  onBack?: () => void;
  /** Icons at the start of the header row's far side (search, add, share…). */
  headerActions?: ReactNode;
  children: ReactNode;
  /** The screen's main actions: a bar BELOW the content (never over it) that the keyboard pushes up (adjustResize). */
  footer?: ReactNode;
  /**
   * What the last press of the footer's action said (missing fields, the use-case's refusal): shown right above the
   * action, so it is on screen even when the form is longer than the phone.
   */
  footerNotice?: ReactNode;
  /** false for screens that render their own FlatList. */
  scroll?: boolean;
  /**
   * When this value changes (not on first render) the content scrolls back to the top: after an action at the bottom
   * of a long page (cancel an invoice) changes what the top says, the user sees it.
   */
  scrollToTopKey?: unknown;
  refreshing?: boolean;
  onRefresh?: () => void;
  testID?: string;
}

/** Every screen: a titled header with a back button, the content, and an optional footer of actions. RTL throughout. */
export function Screen({
  title,
  subtitle,
  back,
  onBack,
  headerActions,
  children,
  footer,
  footerNotice,
  scroll = true,
  scrollToTopKey,
  refreshing = false,
  onRefresh,
  testID,
}: ScreenProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const slot = useHeaderSlot();
  const showBack = back ?? router.canGoBack();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const lastKey = useRef(scrollToTopKey);
  useEffect(() => {
    if (Object.is(lastKey.current, scrollToTopKey)) return;
    lastKey.current = scrollToTopKey;
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [scrollToTopKey]);
  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md }}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            progressBackgroundColor={colors.card}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: 1 }}>{children}</View>
  );
  return (
    <View {...(testID ? { testID } : {})} style={{ flex: 1, backgroundColor: colors.background }}>
      <View
        style={{
          paddingTop: insets.top + spacing.xs,
          paddingHorizontal: spacing.sm,
          minHeight: TOUCH_TARGET + spacing.md,
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.xs,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          backgroundColor: colors.card,
        }}
      >
        {showBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="رجوع"
            testID="screen-back"
            onPress={onBack ?? (() => router.back())}
            hitSlop={8}
            style={{
              width: TOUCH_TARGET,
              height: TOUCH_TARGET,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* RTL: "back" points to the right, where the user came from. */}
            <Ionicons name="arrow-forward" size={24} color={colors.foreground} />
          </Pressable>
        ) : (
          <View style={{ width: spacing.sm }} />
        )}
        <View style={{ flex: 1, paddingVertical: spacing.sm }}>
          <Text
            accessibilityRole="header"
            testID="screen-title"
            numberOfLines={1}
            style={{ fontSize: fontSize.title, fontWeight: "700" }}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={{ color: colors.mutedForeground, fontSize: 14 }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {headerActions ? (
          <View style={{ flexDirection: "row", alignItems: "center" }}>{headerActions}</View>
        ) : null}
        {slot.accessory ? <View style={{ marginStart: spacing.xs }}>{slot.accessory}</View> : null}
      </View>
      {slot.banner}
      {body}
      {footer ? (
        <View
          testID="screen-footer"
          style={{
            padding: spacing.md,
            paddingBottom: spacing.md + insets.bottom,
            gap: spacing.sm,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.card,
          }}
        >
          {footerNotice}
          {footer}
        </View>
      ) : null}
    </View>
  );
}

/** A header icon button (≥ 48 dp target). */
export function HeaderIcon({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(testID ? { testID } : {})}
      onPress={onPress}
      hitSlop={8}
      style={{
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons name={icon} size={24} color={colors.foreground} />
    </Pressable>
  );
}
