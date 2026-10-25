// Bottom-sheet style picker: fabric → colour → roll, showing the kg left. A roll with 0 kg is shown but not selectable.
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PickRoll, PickRow } from "../core/inventoryPicker";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export interface RollPickerProps {
  fabrics: PickRow[];
  loadColors(fabricId: string): Promise<PickRow[]>;
  loadRolls(colorId: string): Promise<PickRoll[]>;
  onPick(pick: { fabric: PickRow; color: PickRow; roll: PickRoll }): void;
  onClose(): void;
}

function Row({
  label,
  sub,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  sub?: string;
  disabled?: boolean;
  onPress(): void;
  testID?: string;
}) {
  return (
    <Pressable
      {...(testID ? { testID } : {})}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: TOUCH_TARGET,
        justifyContent: "center",
        padding: spacing.md,
        marginBottom: spacing.xs,
        borderRadius: radius.md,
        backgroundColor: disabled ? colors.muted : colors.card,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ fontSize: fontSize.body }}>{label}</Text>
      {sub ? <Text style={{ color: colors.mutedForeground }}>{sub}</Text> : null}
    </Pressable>
  );
}

export function RollPicker({ fabrics, loadColors, loadRolls, onPick, onClose }: RollPickerProps) {
  const [fabric, setFabric] = useState<PickRow | null>(null);
  const [color, setColor] = useState<PickRow | null>(null);
  const [colorRows, setColorRows] = useState<PickRow[]>([]);
  const [rolls, setRolls] = useState<PickRoll[]>([]);
  return (
    <View
      testID="roll-picker"
      style={{
        backgroundColor: colors.background,
        padding: spacing.lg,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        maxHeight: "80%",
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ fontSize: fontSize.title }}>
          {!fabric ? "اختر القماش" : !color ? "اختر اللون" : "اختر الرول"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="إغلاق"
          onPress={onClose}
          style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }}
        >
          <Text>إغلاق</Text>
        </Pressable>
      </View>
      <ScrollView>
        {!fabric
          ? fabrics.map((f) => (
              <Row
                key={f.id}
                label={f.name}
                onPress={() => {
                  setFabric(f);
                  void loadColors(f.id).then(setColorRows);
                }}
              />
            ))
          : !color
            ? colorRows.map((c) => (
                <Row
                  key={c.id}
                  label={c.name}
                  onPress={() => {
                    setColor(c);
                    void loadRolls(c.id).then(setRolls);
                  }}
                />
              ))
            : rolls.map((r) => (
                <Row
                  key={r.id}
                  testID={`roll-${r.rollNo}`}
                  label={r.rollNo}
                  sub={`المتبقي: ${r.remainingKg} كغ`}
                  disabled={!(r.remainingKg > 0)}
                  onPress={() => onPick({ fabric, color, roll: r })}
                />
              ))}
      </ScrollView>
    </View>
  );
}
