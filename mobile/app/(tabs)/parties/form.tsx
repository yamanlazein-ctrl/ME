import { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { getApp } from "../../../src/core/appRuntime";
import { notifyLocalWrite } from "../../../src/core/syncRunner";
import { invalidateFinancialViews } from "../../../src/hooks/invalidate";
import { PartyFormView, type PartyFormValues } from "../../../src/ui/PartyViews";

export default function PartyForm() {
  const { id, kind } = useLocalSearchParams<{ id?: string; kind?: string }>();
  const qc = useQueryClient();
  const [values, setValues] = useState<PartyFormValues>({ name: "", phone: "", city: "" });
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    void getApp().then(async (app) => {
      const party = app.phone
        ? await app.phone.repos.partyRepo.findById(id, app.phone.context())
        : null;
      if (party) {
        setVersion(party.version ?? 0);
        setValues({ name: party.name, phone: party.phone ?? "", city: party.city ?? "" });
      }
    });
  }, [id]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const app = await getApp();
      if (!app.phone) throw new Error("الجهاز غير مسجّل");
      const body = {
        name: values.name.trim(),
        phone: values.phone || null,
        city: values.city || null,
      };
      const result = id
        ? await app.phone.documents.updateParty(id, body, version)
        : await app.phone.documents.createParty(
            kind === "supplier" ? "supplier" : "customer",
            body,
          );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      notifyLocalWrite();
      await invalidateFinancialViews(qc);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الحفظ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PartyFormView
      values={values}
      error={error}
      busy={busy}
      onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
      onSave={() => void save()}
    />
  );
}
