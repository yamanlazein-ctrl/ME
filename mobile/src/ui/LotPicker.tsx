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
  showCost = false,
}: {
  visible: boolean;
  onClose(): void;
  onPick(lot: PickableLot): void;
  /** Lots already on the invoice. */
  exclude?: string[];
  /** Admin / accountant also see the lot's cost (the desktop shows the entry price on the sale line). */
  showCost?: boolean;
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
        showCost={showCost}
      />
    </Sheet>
  );
}

export function LotPickerView({
  q,
  onQuery,
  lots,
  onPick,
  showCost = false,
}: {
  q: string;
  onQuery(q: string): void;
  lots: PickableLot[] | undefined;
  onPick(lot: PickableLot): void;
  showCost?: boolean;
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
              meta={lotFacts(l, showCost)}
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

/** What tells two lots of the same colour apart: dye number, grammage, width, then the prices. */
export function lotFacts(l: PickableLot, showCost: boolean): string {
  return [
    l.dyeBatch ? `رقم الصبغة ${l.dyeBatch}` : "",
    l.weightGsm ? `كراماج ${l.weightGsm}` : "",
    l.widthCm ? `عرض ${l.widthCm} سم` : "",
    `سعر البيع ${money(l.defaultPricePerKg, l.currency)}`,
    showCost ? `التكلفة ${money(l.costPerKg, l.currency)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
