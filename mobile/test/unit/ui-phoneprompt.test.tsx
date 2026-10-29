import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { PhonePrompt } from "../../src/ui/PhonePrompt";

describe("phone prompt (E13)", () => {
  it("asks for a number for the named customer, offers to save it, sends, and shows a refusal", async () => {
    const onSend = vi.fn();
    const onToggleSave = vi.fn();
    await render(
      <PhonePrompt
        partyName="عميل 1"
        value="0933123456"
        save
        busy={false}
        error="رقم الهاتف غير صالح"
        onChange={() => undefined}
        onToggleSave={onToggleSave}
        onSend={onSend}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByText(/لا يوجد رقم هاتف محفوظ لـ عميل 1/)).toBeTruthy();
    expect(screen.getByTestId("send-error")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("حفظ الرقم في بطاقة العميل"));
    expect(onToggleSave).toHaveBeenCalledOnce();
    fireEvent.press(screen.getByLabelText("إرسال"));
    expect(onSend).toHaveBeenCalledOnce();
  });
});
