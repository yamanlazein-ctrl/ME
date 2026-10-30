import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { UpdateOfferBanner } from "../../src/ui/UpdateBanner";

describe("update offer banner (FR-43)", () => {
  it("shows the version, opens the download, and marks a required update", async () => {
    const onOpen = vi.fn();
    await render(
      <UpdateOfferBanner
        offer={{ versionName: "1.2.0", apkUrl: "https://hub.example/a.apk", required: true }}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("تحديث مطلوب — 1.2.0")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("تنزيل التحديث"));
    expect(onOpen).toHaveBeenCalledWith("https://hub.example/a.apk");
  });
});
