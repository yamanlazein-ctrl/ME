import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { ReportMenuView, ReportPageView } from "../../src/ui/ReportViews";
import { MENU } from "../../src/core/reports";

describe("report views", () => {
  it("lists every report and opens one", async () => {
    const onOpen = vi.fn();
    await render(<ReportMenuView onOpen={onOpen} />);
    expect(screen.getByText("الأرباح")).toBeTruthy();
    expect(MENU.length).toBeGreaterThanOrEqual(12);
    fireEvent.press(screen.getByLabelText("نظرة عامة"));
    expect(onOpen).toHaveBeenCalledWith("summary");
  });

  it("keeps currencies apart and switches the period", async () => {
    const onPeriod = vi.fn();
    await render(
      <ReportPageView
        page={{
          slug: "profit",
          title: "الأرباح",
          total: 0,
          figures: [
            {
              label: "صافي الربح",
              amounts: [
                { currency: "SYP", amount: 1000 },
                { currency: "USD", amount: 10 },
              ],
            },
          ],
          lines: [],
        }}
        title="الأرباح"
        period="all"
        loading={false}
        error={null}
        onPeriod={onPeriod}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText("1,000.00 SYP")).toBeTruthy();
    expect(screen.getByText("10.00 USD")).toBeTruthy();
    expect(screen.getByTestId("report-empty")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("هذا الشهر"));
    expect(onPeriod).toHaveBeenCalledWith("month");
  });

  it("a failed report says so and retries", async () => {
    const onRetry = vi.fn();
    await render(
      <ReportPageView
        page={undefined}
        title="الأرباح"
        period="all"
        loading={false}
        error="تعذّر تحميل البيانات من قاعدة الهاتف."
        onPeriod={() => undefined}
        onRetry={onRetry}
      />,
    );
    await fireEvent.press(screen.getByLabelText("إعادة المحاولة"));
    expect(onRetry).toHaveBeenCalled();
  });
});
