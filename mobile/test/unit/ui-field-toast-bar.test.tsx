import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Field } from "../../src/ui/Field";
import { TOAST_VARIANTS, ToastProvider, ToastView, useToast } from "../../src/ui/Toast";
import { PrimaryActionBar } from "../../src/ui/PrimaryActionBar";
import { TOUCH_TARGET, colors } from "../../src/ui/theme";
import { Pressable, Text } from "react-native";

describe("Field", () => {
  it("ties the label to its input (accessibilityLabelledBy → label nativeID)", async () => {
    await render(<Field label="الاسم" fieldId="name" value="" onChangeText={() => undefined} />);
    const input = screen.getByLabelText("الاسم");
    const label = screen.getByText("الاسم");
    expect(input.props.accessibilityLabelledBy).toBe(label.props.nativeID);
    expect(input.props.style.minHeight).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });

  it("shows an error under the field in the negative colour", async () => {
    await render(<Field label="الاسم" fieldId="n" error="الاسم مطلوب" />);
    expect(screen.getByText("الاسم مطلوب").props.style.color).toBe(colors.negative);
  });
});

describe("Toast (UX-07)", () => {
  it("has exactly the success and error variants, never swapped", async () => {
    expect([...TOAST_VARIANTS]).toEqual(["success", "error"]);
    await render(<ToastView variant="success" message="تم الحفظ" />);
    expect(screen.getByTestId("toast-success")).toBeTruthy();
    expect(screen.queryByTestId("toast-error")).toBeNull();
    await render(<ToastView variant="error" message="فشل" />);
    expect(screen.getByTestId("toast-error")).toBeTruthy();
  });

  it("useToast().success renders a success toast, .error an error toast", async () => {
    vi.useFakeTimers();
    function Probe() {
      const toast = useToast();
      return (
        <>
          <Pressable accessibilityLabel="ok" onPress={() => toast.success("تم")}>
            <Text>ok</Text>
          </Pressable>
          <Pressable accessibilityLabel="bad" onPress={() => toast.error("خطأ")}>
            <Text>bad</Text>
          </Pressable>
        </>
      );
    }
    await render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
    await fireEvent.press(screen.getByLabelText("ok"));
    expect(screen.getByTestId("toast-success")).toBeTruthy();
    expect(screen.queryByTestId("toast-error")).toBeNull();
    await fireEvent.press(screen.getByLabelText("bad"));
    expect(screen.getByTestId("toast-error")).toBeTruthy();
    await act(async () => void vi.advanceTimersByTime(5000));
    vi.useRealTimers();
  });
});

describe("PrimaryActionBar (UX-02)", () => {
  it("is pinned to the bottom, at least 48 dp tall and calls onPress", async () => {
    const onPress = vi.fn();
    await render(<PrimaryActionBar label="حفظ" onPress={onPress} />);
    const bar = screen.getByTestId("primary-action-bar");
    expect(bar.props.style.position).toBe("absolute");
    expect(bar.props.style.bottom).toBe(0);
    const button = screen.getByLabelText("حفظ");
    expect(button.props.style.minHeight).toBeGreaterThanOrEqual(48);
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not fire while disabled", async () => {
    const onPress = vi.fn();
    await render(<PrimaryActionBar label="حفظ" onPress={onPress} disabled />);
    await fireEvent.press(screen.getByLabelText("حفظ"));
    expect(onPress).not.toHaveBeenCalled();
  });
});
