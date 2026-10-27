import { useState } from "react";
import { router } from "expo-router";
import { randomUUID } from "node:crypto";
import { getApp } from "../../../../src/core/appRuntime";
import { pickColors, pickFabrics, type PickRow } from "../../../../src/core/inventoryPicker";
import { entryDraftStore, useEntryDraft } from "../../../../src/hooks/useEntryDraft";
import { EntryLineForm, EntryLinesView } from "../../../../src/ui/EntryViews";

export default function EntryLines() {
  const draft = useEntryDraft();
  const [adding, setAdding] = useState(false);
  const [fabrics, setFabrics] = useState<PickRow[]>([]);
  const [colorsOfFabric, setColorsOfFabric] = useState<PickRow[]>([]);
  const phone = async () => {
    const app = await getApp();
    if (!app.phone) throw new Error("الجهاز غير مسجّل");
    return app.phone;
  };
  const form = (
    <EntryLineForm
      fabricSuggestions={fabrics}
      colorSuggestions={colorsOfFabric}
      onFabricQuery={(q, fabricId) => {
        void phone().then(async (p) => {
          setFabrics(q.trim() ? await pickFabrics(p, q.trim()) : []);
          setColorsOfFabric(fabricId ? await pickColors(p, fabricId) : []);
        });
      }}
      onColorQuery={() => undefined}
      onCancel={() => setAdding(false)}
      onSave={(line) => {
        entryDraftStore.update({
          lines: [
            ...entryDraftStore.get().lines,
            {
              key: randomUUID(),
              ...(line.fabricId ? { fabricId: line.fabricId } : {}),
              fabricName: line.fabricName,
              ...(line.colorId ? { colorId: line.colorId } : {}),
              colorName: line.colorName,
              ...(line.dyeBatch.trim() ? { dyeBatch: line.dyeBatch } : {}),
              quantityKg: line.quantityKg,
              pieces: line.pieces,
              pricePerKg: line.pricePerKg,
            },
          ],
        });
        setFabrics([]);
        setColorsOfFabric([]);
        setAdding(false);
      }}
    />
  );
  return (
    <EntryLinesView
      draft={draft}
      adding={adding}
      form={adding ? form : null}
      onAdd={() => setAdding(true)}
      onRemove={(key) =>
        entryDraftStore.update({ lines: entryDraftStore.get().lines.filter((l) => l.key !== key) })
      }
      onNext={() => router.push("/(tabs)/add/entry/review" as never)}
    />
  );
}
