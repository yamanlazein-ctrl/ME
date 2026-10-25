import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { MoneyText } from "../../src/ui/MoneyText";
import { MoneyInput } from "../../src/ui/MoneyInput";
import { formatAmount, normalizeTyping, parseTypedAmount } from "../../src/ui/money";
import { colors } from "../../src/ui/theme";

describe("MoneyText (UX-05)", () => {
  it("always shows the currency next to the amount", async () => {
    await render(<MoneyText amount={1250.5} currency="USD" />);
    expect(screen.getByText("1,250.50 USD")).toBeTruthy();
    await render(<MoneyText amount={3400000} currency="SYP" />);
    expect(screen.getByText("3,400,000.00 SYP")).toBeTruthy();
  });

  it("shows a minus sign AND the negative colour for a negative amount", async () => {
    await render(<MoneyText amount={-75.25} currency="USD" />);
    const node = screen.getByText("−75.25 USD");
    expect(node.props.style.color).toBe(colors.negative);
    await render(<MoneyText amount={75.25} currency="USD" />);
    expect(screen.getByText("75.25 USD").props.style.color).toBe(colors.foreground);
  });

  it("formats exactly like round2dp, half away from zero", () => {
    expect(formatAmount(1.005)).toBe("1.01");
    expect(formatAmount(-2.675)).toBe("−2.68");
    expect(formatAmount(0)).toBe("0.00");
  });
});

describe("MoneyInput (UX-08)", () => {
  it("uses the decimal keypad, groups thousands while typing and refuses a third decimal", async () => {
    const seen: Array<number | null> = [];
    await render(
      <MoneyInput label="المبلغ" fieldId="amount" onChangeAmount={(v) => seen.push(v)} />,
    );
    const input = screen.getByLabelText("المبلغ");
    expect(input.props.keyboardType).toBe("decimal-pad");
    await fireEvent.changeText(input, "1250");
    expect(screen.getByLabelText("المبلغ").props.value).toBe("1,250");
    await fireEvent.changeText(screen.getByLabelText("المبلغ"), "1,250.5");
    expect(screen.getByLabelText("المبلغ").props.value).toBe("1,250.5");
    await fireEvent.changeText(screen.getByLabelText("المبلغ"), "1,250.567"); // refused
    expect(screen.getByLabelText("المبلغ").props.value).toBe("1,250.5");
    await fireEvent.changeText(screen.getByLabelText("المبلغ"), "12a");
    expect(screen.getByLabelText("المبلغ").props.value).toBe("1,250.5");
    expect(seen.at(-1)).toBe(1250.5);
  });

  it("parses and normalizes", () => {
    expect(parseTypedAmount("1,234.50")).toBe(1234.5);
    expect(parseTypedAmount("")).toBeNull();
    expect(normalizeTyping("007")).toBe("7");
    expect(normalizeTyping("0.5")).toBe("0.5");
    expect(normalizeTyping("1.234")).toBeNull();
    const fn = vi.fn();
    fn();
  });
});
