// The customer's phone showed the bottom of the app under its navigation buttons. These rules keep every bottom element
// above the phone's navigation bar (3 buttons or gesture line), whatever its height.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { stubInsets } from "../helpers/safeAreaStub";
import { tabsProps } from "../helpers/expoRouterStub";
import { flat } from "../helpers/style";
import { Button, Screen } from "../../src/ui/kit";
import { TabScope } from "../../src/ui/kit/tabScope";
import { ToastView } from "../../src/ui/Toast";
import { TAB_BAR_HEIGHT } from "../../src/ui/theme";

vi.mock("../../src/core/sessionService", () => ({
  getSessionService: async () => ({ current: async () => null }),
}));

const NAV_BAR = 48;

afterEach(() => {
  stubInsets.bottom = 0;
  stubInsets.top = 0;
});

describe("bottom of the app clears the phone's navigation bar", () => {
  it("the tab bar is its own height plus the navigation bar, padded by it, and has no fixed label line height", async () => {
    stubInsets.bottom = NAV_BAR;
    const { default: TabsLayout } = await import("../../app/(tabs)/_layout");
    await render(<TabsLayout />);
    const options = tabsProps.last?.screenOptions as {
      tabBarStyle: { height: number; paddingBottom: number };
      tabBarLabelStyle?: { lineHeight?: number };
      tabBarLabel: (p: { color: string; children: string }) => React.ReactElement;
    };
    expect(options.tabBarStyle.height).toBe(TAB_BAR_HEIGHT + NAV_BAR);
    expect(options.tabBarStyle.paddingBottom).toBeGreaterThanOrEqual(NAV_BAR);
    expect(options.tabBarLabelStyle?.lineHeight).toBeUndefined();
    // One line, and it grows with the phone's font size only up to 1.2× so it fits the bar.
    const label = options.tabBarLabel({ color: "#fff", children: "العملاء والموردون" });
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.maxFontSizeMultiplier).toBeLessThanOrEqual(1.2);
  });

  it("a footer outside the tabs leaves room for the navigation bar; inside the tabs the tab bar already does", async () => {
    stubInsets.bottom = NAV_BAR;
    const page = (
      <Screen title="فاتورة" footer={<Button label="حفظ" onPress={() => undefined} />}>
        <Text>محتوى</Text>
      </Screen>
    );
    await render(page);
    expect(
      flat(screen.getByTestId("screen-footer").props.style).paddingBottom,
    ).toBeGreaterThanOrEqual(NAV_BAR);
    await render(<TabScope>{page}</TabScope>);
    expect(flat(screen.getByTestId("screen-footer").props.style).paddingBottom).toBeLessThan(
      NAV_BAR,
    );
  });

  it("a message (toast) floats at the top, under the status bar, never at the bottom", async () => {
    stubInsets.top = 24;
    await render(<ToastView variant="success" message="تم الحفظ" />);
    const style = flat(screen.getByTestId("toast-success").props.style);
    expect(style.position).toBe("absolute");
    expect(style.top).toBeGreaterThanOrEqual(24);
    expect(style.bottom).toBeUndefined();
  });
});
