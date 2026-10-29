import { View } from "react-native";
import { Text } from "./Text";
import {
  deriveSyncState,
  syncLabel,
  type SyncChipState,
  type SyncInputs,
} from "../hooks/syncState";
import { fontSize, radius, spacing, type Colors } from "./theme";
import { useColors } from "./themeContext-core";

function tone(
  kind: SyncChipState["kind"],
  colors: Colors,
): { background: string; foreground: string } {
  switch (kind) {
    case "synced":
      return { background: colors.card, foreground: colors.positive };
    case "pending":
      return { background: colors.card, foreground: colors.warning };
    case "offline":
      return { background: colors.muted, foreground: colors.mutedForeground };
    default:
      return { background: colors.card, foreground: colors.negative };
  }
}

export function SyncChip({ state }: { state: SyncChipState }) {
  const palette = tone(state.kind, useColors());
  return (
    <View
      testID={`sync-chip-${state.kind}`}
      accessibilityLabel={syncLabel(state)}
      style={{
        backgroundColor: palette.background,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: palette.foreground,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        minHeight: 32,
        justifyContent: "center",
      }}
    >
      <Text style={{ color: palette.foreground, fontSize: fontSize.caption }}>
        {syncLabel(state)}
      </Text>
    </View>
  );
}

export function SyncChipFromInputs(inputs: SyncInputs) {
  return <SyncChip state={deriveSyncState(inputs)} />;
}
