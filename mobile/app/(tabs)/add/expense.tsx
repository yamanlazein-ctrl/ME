import { useEffect, useState } from "react";
import { router } from "expo-router";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../src/core/appRuntime";
import { useFinishWrite } from "../../../src/hooks/useFinishWrite";
import { ExpenseForm, type ExpenseFormValues } from "../../../src/ui/ExpenseForm";

export default function ExpenseScreen() {
  const finish = useFinishWrite();
  const [values, setValues] = useState<ExpenseFormValues>({
    name: "",
    amount: null,
    currency: "USD",
  });
  const [names, setNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Names typed before (the category is the name on the desktop too).
  useEffect(() => {
    void getApp().then(async (app) => {
      if (!app.phone) return;
      const page = await app.phone.repos.expenseRepo.list({ limit: 100 }, app.phone.context());
      setNames([...new Set(page.data.map((e) => e.category))]);
    });
  }, []);
  const typed = values.name.trim().toLowerCase();
  const suggestions = typed
    ? names.filter((n) => n.toLowerCase().includes(typed) && n !== values.name)
    : [];

  const save = async () => {
    if (!values.amount) return;
    setBusy(true);
    setError(null);
    try {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      const name = values.name.trim();
      const result = await app.phone.documents.createExpense({
        category: name,
        description: name,
        amount: values.amount,
        currency: values.currency,
        date: localDateISO(new Date()),
        method: "cash",
        paidFromCashbox: true,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await finish();
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ExpenseForm
      values={values}
      suggestions={suggestions}
      error={error}
      busy={busy}
      onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
      onSave={() => void save()}
    />
  );
}
