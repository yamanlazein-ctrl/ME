import { type TextStyle } from "react-native";
import { Text } from "./Text";
import { formatAmount } from "./money";
import { fontSize } from "./theme";
import { useColors } from "./themeContext-core";

export interface MoneyTextProps {
  amount: number;
  /** Always shown next to the amount (UX-05). */
  currency: string;
  style?: TextStyle;
}

/** An amount with its currency. A negative amount shows a minus sign AND the `negative` colour (UX-05). */
export function MoneyText({ amount, currency, style }: MoneyTextProps) {
  const colors = useColors();
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
