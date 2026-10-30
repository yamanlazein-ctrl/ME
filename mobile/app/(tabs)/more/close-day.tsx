import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { getApp } from "../../../src/core/appRuntime";
import { cashboxBalances } from "../../../src/core/cashbox";
import { isAdminLike } from "../../../src/core/roles";
import { queryKeys } from "../../../src/hooks/queryKeys";
import { useFinishWrite } from "../../../src/hooks/useFinishWrite";
import { useRole } from "../../../src/hooks/useRole";
import { Field } from "../../../src/ui/Field";
import { money } from "../../../src/ui/format";
import { MoneyInput } from "../../../src/ui/MoneyInput";
import { CURRENCY_OPTIONS } from "../../../src/ui/SaleViews";
import {
  Button,
  Chips,
  ConfirmSheet,
  KeyValue,
  Notice,
  Screen,
  Section,
} from "../../../src/ui/kit";

export default function CloseDay() {
  const role = useRole();
  const finish = useFinishWrite();
  const [date, setDate] = useState(localDateISO(new Date()));
  const [currency, setCurrency] = useState("USD");
  const [counted, setCounted] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { data } = useQuery({
    queryKey: [...queryKeys.cashbox, "close", date],
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? cashboxBalances(app.phone, date) : ({} as Record<string, number>);
    },
  });
  if (!isAdminLike(role)) {
    return (
      <Screen title="إقفال اليوم">
        <Notice
          kind="info"
          text="إقفال اليوم متاح للمدير والمحاسب فقط."
          testID="close-day-denied"
        />
      </Screen>
    );
  }
  const system = data?.[currency] ?? 0;
  const difference = counted === null ? null : Math.round((counted - system) * 100) / 100;
  const close = async () => {
    if (counted === null) return;
    setError(null);
    setNotice(null);
    const app = await getApp();
    if (!app.phone) return;
    const r = await app.phone.documents.closeCashboxDay({ date, counted, currency });
    if (!r.ok) return setError(r.error);
    await finish();
    setNotice(`تم إقفال يوم ${date} (${currency})`);
  };
  return (
    <Screen
      title="إقفال اليوم"
      subtitle="مطابقة النقد الفعلي مع رصيد النظام"
      footer={
        <Button
          label="إقفال اليوم"
          disabled={counted === null}
          onPress={() => setConfirming(true)}
          testID="close-day"
        />
      }
    >
      <Section>
        <Field
          label="التاريخ (سنة-شهر-يوم)"
          fieldId="close-date"
          value={date}
          onChangeText={setDate}
        />
        <Chips
          options={CURRENCY_OPTIONS}
          value={currency}
          onChange={setCurrency}
          testIDPrefix="close-currency"
        />
        <KeyValue label="رصيد النظام" value={money(system, currency)} strong />
        <MoneyInput
          label="المبلغ المعدود فعلياً"
          fieldId="close-counted"
          onChangeAmount={setCounted}
        />
        {difference !== null ? (
          <KeyValue
            label={
              difference === 0 ? "لا فرق" : difference > 0 ? "زيادة في الصندوق" : "نقص في الصندوق"
            }
            value={money(Math.abs(difference), currency)}
            tone={difference === 0 ? "positive" : "warning"}
          />
        ) : null}
      </Section>
      {error ? <Notice kind="error" text={error} testID="close-error" /> : null}
      {notice ? <Notice kind="success" text={notice} testID="close-notice" /> : null}
      <ConfirmSheet
        visible={confirming}
        title="إقفال اليوم"
        message={`سيُقفل يوم ${date} لعملة ${currency}: لا تُقبل بعده حركات صندوق بهذا التاريخ. لا يمكن التراجع.`}
        confirmLabel="إقفال"
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await close();
          setConfirming(false);
        }}
      />
    </Screen>
  );
}
