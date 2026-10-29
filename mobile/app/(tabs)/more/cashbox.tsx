import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../src/core/appRuntime";
import { cashboxBalances, cashboxMovementsOn } from "../../../src/core/cashbox";
import { queryKeys } from "../../../src/hooks/queryKeys";
import { useFinishWrite } from "../../../src/hooks/useFinishWrite";
import { useRole } from "../../../src/hooks/useRole";
import { CashboxView, type CashboxViewProps } from "../../../src/ui/CashboxView";

function shift(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return localDateISO(d);
}

export default function CashboxScreen() {
  const role = useRole();
  const finish = useFinishWrite();
  const [date, setDate] = useState(localDateISO(new Date()));
  const [form, setForm] = useState<CashboxViewProps["form"]>({
    direction: "in",
    currency: "USD",
    amount: null,
    description: "",
  });
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: [...queryKeys.cashbox, date],
    queryFn: async () => {
      const app = await getApp();
      if (!app.phone) return { balances: {}, movements: {} };
      const balances = await cashboxBalances(app.phone, date);
      const movements: Record<string, { in: number; out: number }> = {};
      for (const c of Object.keys(balances))
        movements[c] = await cashboxMovementsOn(app.phone, date, c);
      return { balances, movements };
    },
  });
  const add = async () => {
    if (!form.amount) return;
    setError(null);
    const app = await getApp();
    if (!app.phone) return;
    const r = await app.phone.documents.addCashboxMovement({
      date,
      type: form.direction === "in" ? "capital" : "withdrawal",
      direction: form.direction,
      amount: form.amount,
      currency: form.currency,
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
    });
    if (!r.ok) return setError(r.error);
    await finish();
    setForm({ ...form, amount: null, description: "" });
  };
  return (
    <CashboxView
      date={date}
      role={role}
      balances={data?.balances ?? {}}
      movements={data?.movements ?? {}}
      form={form}
      error={error}
      onDate={setDate}
      onShiftDay={(d) => setDate((cur) => shift(cur, d))}
      onForm={(patch) => setForm((f) => ({ ...f, ...patch }))}
      onAdd={() => void add()}
    />
  );
}
