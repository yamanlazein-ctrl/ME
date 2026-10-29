import { useState } from "react";
import { getApp } from "../../../src/core/appRuntime";
import { useFinishWrite } from "../../../src/hooks/useFinishWrite";
import { useCountSheet } from "../../../src/hooks/useInventory";
import { CountSheetView } from "../../../src/ui/InventoryViews";

export default function Count() {
  const year = new Date().getFullYear();
  const [q, setQ] = useState("");
  const { data } = useCountSheet(year, q);
  const finish = useFinishWrite();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <CountSheetView
      lines={data?.lines ?? []}
      total={data?.total ?? 0}
      q={q}
      error={error}
      notice={notice}
      onQuery={setQ}
      onRecord={async (line, countedKg) => {
        setError(null);
        setNotice(null);
        const app = await getApp();
        if (!app.phone) return;
        const r = await app.phone.documents.recordCount({ year, rollId: line.rollId, countedKg });
        if (!r.ok) return setError(r.error);
        setNotice(`تم تسجيل العدّ للصبغة ${line.rollNo}`);
        await finish();
      }}
      onPost={async (line) => {
        if (!line.countId) return;
        setError(null);
        setNotice(null);
        const app = await getApp();
        if (!app.phone) return;
        const r = await app.phone.documents.postCount(line.countId);
        if (!r.ok) return setError(r.error);
        setNotice(`تم ترحيل فرق الصبغة ${line.rollNo}`);
        await finish();
      }}
    />
  );
}
