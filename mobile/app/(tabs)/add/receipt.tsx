import { useLocalSearchParams } from "expo-router";
import { VoucherScreen } from "../../../src/ui/VoucherScreen";

export default function Screen() {
  const { amendId, partyId } = useLocalSearchParams<{ amendId?: string; partyId?: string }>();
  return (
    <VoucherScreen
      kind="receipt"
      {...(amendId ? { amendId } : {})}
      {...(partyId ? { partyId } : {})}
    />
  );
}
