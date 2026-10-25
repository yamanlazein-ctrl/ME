import { useEffect, useState } from "react";
import { Modal, View } from "react-native";
import { router } from "expo-router";
import { randomUUID } from "node:crypto";
import { getApp } from "../../../../src/core/appRuntime";
import {
  pickColors,
  pickFabrics,
  pickRolls,
  type PickRow,
} from "../../../../src/core/inventoryPicker";
import type { DraftLine } from "../../../../src/core/saleDraft";
import { saleDraftStore, useSaleDraft } from "../../../../src/hooks/useSaleDraft";
import { RollPicker } from "../../../../src/ui/RollPicker";
import { SaleLinesView } from "../../../../src/ui/SaleViews";

export default function SaleLines() {
  const draft = useSaleDraft();
  const [picking, setPicking] = useState(false);
  const [fabrics, setFabrics] = useState<PickRow[]>([]);
  useEffect(() => {
    if (!picking) return;
    void getApp().then(async (app) => {
      if (app.phone) setFabrics(await pickFabrics(app.phone, ""));
    });
  }, [picking]);
  const phone = async () => {
    const app = await getApp();
    if (!app.phone) throw new Error("الجهاز غير مسجّل");
    return app.phone;
  };
  return (
    <View style={{ flex: 1 }}>
      <SaleLinesView
        draft={draft}
        onAddLine={() => setPicking(true)}
        onRemove={(key) =>
          saleDraftStore.update({ lines: draft.lines.filter((l) => l.key !== key) })
        }
        onEdit={(key, patch) =>
          saleDraftStore.update({
            lines: saleDraftStore.get().lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
          })
        }
        onNext={() => router.push("/(tabs)/add/sale/review" as never)}
      />
      <Modal
        visible={picking}
        transparent
        animationType="slide"
        onRequestClose={() => setPicking(false)}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.3)" }}>
          <RollPicker
            fabrics={fabrics}
            loadColors={async (id) => pickColors(await phone(), id)}
            loadRolls={async (id) => pickRolls(await phone(), id)}
            onClose={() => setPicking(false)}
            onPick={({ fabric, color, roll }) => {
              const line: DraftLine = {
                key: randomUUID(),
                fabricId: fabric.id,
                fabricName: fabric.name,
                colorId: color.id,
                colorName: color.name,
                rollId: roll.id,
                rollNo: roll.rollNo,
                remainingKg: roll.remainingKg,
                quantityKg: Math.min(1, roll.remainingKg),
                pieces: 0,
                pricePerKg: roll.pricePerKg,
                discountAmount: 0,
              };
              saleDraftStore.update({ lines: [...saleDraftStore.get().lines, line] });
              setPicking(false);
            }}
          />
        </View>
      </Modal>
    </View>
  );
}
