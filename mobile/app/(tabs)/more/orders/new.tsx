import { useState } from "react";
import { router } from "expo-router";
import { randomUUID } from "node:crypto";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../../src/core/appRuntime";
import { useFinishWrite } from "../../../../src/hooks/useFinishWrite";
import type { PickedParty } from "../../../../src/ui/PartyPicker";
import { OrderFormView, type OrderDraftItem } from "../../../../src/ui/OrderViews";

export default function NewOrder() {
  const finish = useFinishWrite();
  const [customer, setCustomer] = useState<PickedParty | null>(null);
  const [items, setItems] = useState<OrderDraftItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!customer || items.length === 0) return;
    setError(null);
    try {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      const r = await app.phone.documents.createOrder({
        customerId: customer.id,
        customerNameSnapshot: customer.name,
        date: localDateISO(new Date()),
        currency: "USD",
        items: items.map((i) => ({
          fabricName: i.fabricName,
          colorName: i.colorName,
          requestedKg: i.requestedKg,
        })),
      });
      if (!r.ok) return setError(r.error);
      await finish();
      router.replace("/(tabs)/more/orders" as never);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ");
    }
  };
  return (
    <OrderFormView
      customer={customer}
      items={items}
      error={error}
      onCustomer={setCustomer}
      onAddItem={(item) => setItems((cur) => [...cur, { key: randomUUID(), ...item }])}
      onRemoveItem={(key) => setItems((cur) => cur.filter((i) => i.key !== key))}
      onSave={save}
    />
  );
}
