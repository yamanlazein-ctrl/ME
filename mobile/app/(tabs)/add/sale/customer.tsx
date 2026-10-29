import { router } from "expo-router";
import { saleDraftStore, useSaleDraft } from "../../../../src/hooks/useSaleDraft";
import { SaleCustomerView } from "../../../../src/ui/SaleViews";

export default function SaleCustomer() {
  const draft = useSaleDraft();
  return (
    <SaleCustomerView
      draft={draft}
      onParty={(party) => saleDraftStore.update({ party })}
      onCurrency={(currency) => saleDraftStore.update({ currency })}
      onRate={(exchangeRate) => saleDraftStore.update({ exchangeRate })}
      onNext={() => router.push("/(tabs)/add/sale/lines" as never)}
    />
  );
}
