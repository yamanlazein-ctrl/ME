import { useLocalSearchParams } from "expo-router";
import { VoucherScreen } from "../../../src/ui/VoucherScreen";

export default function Screen() {
  const { amendId } = useLocalSearchParams<{ amendId?: string }>();
  return <VoucherScreen kind="receipt" {...(amendId ? { amendId } : {})} />;
}
