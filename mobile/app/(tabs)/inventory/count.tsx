import { useState } from "react";
import { runPhoneAction } from "../../../src/core/phoneAction";
import { useFinishWrite } from "../../../src/hooks/useFinishWrite";
import { useCountSheet } from "../../../src/hooks/useInventory";
import { CountSheetView } from "../../../src/ui/InventoryViews";
import { canWriteOffline } from "../../../src/core/roles";
import { useRole } from "../../../src/hooks/useRole";
import { Notice, Screen } from "../../../src/ui/kit";

export default function Count() {
  const year = new Date().getFullYear();
  const [q, setQ] = useState("");
  const { data } = useCountSheet(year, q);
  const finish = useFinishWrite();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const role = useRole();
  // The list hides the count for viewers; a deep link must not reach it either.
  if (!canWriteOffline(role)) {
    return (
      <Screen title="الجرد">
        <Notice kind="info" text="الجرد متاح لمن يملك صلاحية التعديل فقط." testID="count-denied" />
      </Screen>
    );
  }
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
        const r = await runPhoneAction(
          "count",
          (phone) => phone.documents.recordCount({ year, rollId: line.rollId, countedKg }),
          setError,
        );
        if (!r) return;
        if (!r.ok) return setError(r.error);
        setNotice(`تم تسجيل العدّ للصبغة ${line.rollNo}`);
        await finish();
      }}
      onPost={async (line) => {
        const countId = line.countId;
        if (!countId) return;
        setError(null);
        setNotice(null);
        const r = await runPhoneAction(
          "count",
          (phone) => phone.documents.postCount(countId),
          setError,
        );
        if (!r) return;
        if (!r.ok) return setError(r.error);
        setNotice(`تم ترحيل فرق الصبغة ${line.rollNo}`);
        await finish();
      }}
    />
  );
}
