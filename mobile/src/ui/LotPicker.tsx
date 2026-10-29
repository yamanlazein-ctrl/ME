// Choosing a dye lot for a sale line: one search over fabric, colour, colour code and lot number, lots with stock only.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getApp } from "../core/appRuntime";
import { pickLots, type PickableLot } from "../core/stock";
import { queryKeys } from "../hooks/queryKeys";
import { kg, money, piecesText } from "./format";
import { EmptyState, ListRow, LoadingState, SearchBar, Section, Sheet } from "./kit";

export function LotPickerSheet({
  visible,
  onClose,
  onPick,
  exclude = [],
}: {
  visible: boolean;
  onClose(): void;
  onPick(lot: PickableLot): void;
  /** Lots already on the invoice. */
  exclude?: string[];
}) {
  const [q, setQ] = useState("");
  const lots = useQuery({
    queryKey: [...queryKeys.inventory, "pick", q],
    enabled: visible,
    queryFn: async () => {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      return pickLots(app.phone, q);
    },
    placeholderData: (previous) => previous,
  });
  return (
    <Sheet visible={visible} title="اختر الصبغة" onClose={onClose} testID="lot-sheet">
      <LotPickerView
        q={q}
        onQuery={setQ}
        lots={lots.data?.filter((l) => !exclude.includes(l.id))}
        onPick={onPick}
      />
    </Sheet>
  );
}

export function LotPickerView({
  q,
  onQuery,
  lots,
  onPick,
}: {
  q: string;
  onQuery(q: string): void;
  lots: PickableLot[] | undefined;
  onPick(lot: PickableLot): void;
}) {
  return (
    <>
      <SearchBar
        value={q}
        onChange={onQuery}
        placeholder="القماش، اللون، رقم اللون أو رقم الصبغة"
        testID="lot-search"
      />
      {!lots ? (
        <LoadingState />
      ) : lots.length === 0 ? (
        <EmptyState icon="cube-outline" title="لا صبغات متوفرة مطابقة" />
      ) : (
        <Section padded={false}>
          {lots.map((l, i) => (
            <ListRow
              key={l.id}
              testID="lot-option"
              accessibilityLabel={`صبغة ${l.rollNo}`}
              title={`${l.fabricName} · ${l.colorName}`}
              subtitle={`صبغة ${l.rollNo}${l.colorCode ? ` · رقم اللون ${l.colorCode}` : ""}`}
              meta={`سعر البيع ${money(l.defaultPricePerKg, l.currency)}`}
              value={kg(l.remainingKg)}
              valueCaption={piecesText(l.remainingPieces)}
              onPress={() => onPick(l)}
              last={i === lots.length - 1}
            />
          ))}
        </Section>
      )}
    </>
  );
}
