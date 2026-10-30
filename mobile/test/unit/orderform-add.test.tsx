import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { OrderFormView } from "../../src/ui/OrderViews";

vi.mock("../../src/hooks/useParties", () => ({ usePartyList: () => ({ data: [] }) }));

describe("order form add item", () => {
  it("adds an item after typing fabric, colour and kg", async () => {
    const onAddItem = vi.fn();
    await render(
      <OrderFormView
        customer={{ id: "p", name: "عميل" }}
        items={[]}
        error={null}
        onCustomer={() => undefined}
        onAddItem={onAddItem}
        onRemoveItem={() => undefined}
        onSave={() => undefined}
      />,
    );
    await fireEvent.changeText(screen.getByTestId("order-fabric"), "Ordfab");
    await fireEvent.changeText(screen.getByTestId("order-color"), "Ordcolor");
    await fireEvent.changeText(screen.getByTestId("order-kg"), "25");
    await fireEvent.press(screen.getByLabelText("إضافة البند"));
    expect(onAddItem).toHaveBeenCalledWith({
      fabricName: "Ordfab",
      colorName: "Ordcolor",
      requestedKg: 25,
    });
  });
});
