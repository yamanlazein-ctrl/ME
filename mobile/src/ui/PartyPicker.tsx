import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { useParties } from "../hooks/useParties";
import { Field } from "./Field";
import { colors, radius, spacing, TOUCH_TARGET } from "./theme";

export interface PickedParty {
  id: string;
  name: string;
}

/** Search-and-choose party field used by vouchers and the sale flow. */
export function PartyPicker({
  kind,
  value,
  onPick,
}: {
  kind: "customer" | "supplier";
  value: PickedParty | null;
  onPick(party: PickedParty): void;
}) {
  const [q, setQ] = useState("");
  const { data } = useParties(q, kind);
  if (value) {
    return (
      <View style={{ marginBottom: spacing.lg }}>
        <Text style={{ color: colors.mutedForeground }}>
          {kind === "customer" ? "العميل" : "المورد"}
        </Text>
        <Text testID="picked-party">{value.name}</Text>
      </View>
    );
  }
  return <PartyPickerView q={q} onQuery={setQ} rows={data} onPick={onPick} />;
}

export function PartyPickerView({
  q,
  onQuery,
  rows,
  onPick,
}: {
  q: string;
  onQuery(q: string): void;
  rows: Array<{ id: string; name: string }>;
  onPick(party: PickedParty): void;
}) {
  return (
    <View>
      <Field
        label="الطرف"
        fieldId="picker-search"
        value={q}
        onChangeText={onQuery}
        placeholder="ابحث بالاسم أو الرمز"
      />
      {rows.slice(0, 8).map((r) => (
        <Pressable
          key={r.id}
          testID="party-option"
          accessibilityRole="button"
          onPress={() => onPick({ id: r.id, name: r.name })}
          style={{
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            padding: spacing.md,
            backgroundColor: colors.card,
            borderRadius: radius.md,
            marginBottom: spacing.xs,
          }}
        >
          <Text>{r.name}</Text>
        </Pressable>
      ))}
    </View>
  );
}
