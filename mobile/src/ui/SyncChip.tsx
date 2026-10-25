import { Text, View } from "react-native";
import {
  deriveSyncState,
  syncLabel,
  type SyncChipState,
  type SyncInputs,
} from "../hooks/syncState";
import { colors, fontSize, radius, spacing } from "./theme";

const TONE: Record<SyncChipState["kind"], { background: string; foreground: string }> = {
  synced: { background: "#dcfce7", foreground: colors.positive },
  pending: { background: "#fef3c7", foreground: "#92400e" },
  offline: { background: colors.muted, foreground: colors.mutedForeground },
  attention: { background: "#fee2e2", foreground: colors.negative },
};

export function SyncChip({ state }: { state: SyncChipState }) {
  const tone = TONE[state.kind];
  return (
    <View
      testID={`sync-chip-${state.kind}`}
      accessibilityLabel={syncLabel(state)}
      style={{
        backgroundColor: tone.background,
        borderRadius: radius.xl,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        minHeight: 32,
        justifyContent: "center",
      }}
    >
      <Text style={{ color: tone.foreground, fontSize: fontSize.caption }}>{syncLabel(state)}</Text>
    </View>
  );
}

export function SyncChipFromInputs(inputs: SyncInputs) {
  return <SyncChip state={deriveSyncState(inputs)} />;
}
