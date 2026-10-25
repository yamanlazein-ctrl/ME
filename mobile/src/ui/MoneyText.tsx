import { Text, type TextStyle } from "react-native";
import { formatAmount } from "./money";
import { colors, fontSize } from "./theme";

export interface MoneyTextProps {
  amount: number;
  /** Always shown next to the amount (UX-05). */
  currency: string;
  style?: TextStyle;
}

/** An amount with its currency. A negative amount shows a minus sign AND the `negative` colour (UX-05). */
export function MoneyText({ amount, currency, style }: MoneyTextProps) {
  const negative = amount < 0;
  return (
    <Text
      accessibilityLabel={`${formatAmount(amount)} ${currency}`}
      style={{
        fontSize: fontSize.amount,
        color: negative ? colors.negative : colors.foreground,
        writingDirection: "ltr",
        ...style,
      }}
    >
      {`${formatAmount(amount)} ${currency}`}
    </Text>
  );
}
