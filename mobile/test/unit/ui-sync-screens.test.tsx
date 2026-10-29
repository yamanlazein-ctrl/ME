import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { SyncStatusView, DESKTOP_ONLY_TEXT } from "../../src/ui/SyncStatusView";
import { UpdateBanner } from "../../src/ui/UpdateBanner";
import type { SyncStatus } from "../../src/core/syncRunner";

const status: SyncStatus = {
  running: false,
  lastRunAt: "2026-03-01T10:00:00Z",
  lastError: null,
  halted: null,
  clockSkewMs: null,
  rejected: [
    { opId: "op1", entityType: "invoice", number: "INV-7", reason: "claim lost", rollIds: [] },
  ],
  hubDeadOps: ["op9"],
};

describe("sync status screen (FR-37, E5)", () => {
  it("lists rejected and dead documents with the desktop-only text and no requeue control", async () => {
    await render(<SyncStatusView status={status} pending={3} />);
    expect(screen.getByText("بانتظار الإرسال: 3")).toBeTruthy();
    expect(screen.getAllByText(DESKTOP_ONLY_TEXT)).toHaveLength(2);
    expect(screen.getByText("مستند مرفوض: INV-7")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/إعادة/)).toBeNull();
  });
});

describe("update banner (FR-38, E9)", () => {
  it("shows while the version is refused and opens the update link", async () => {
    const onOpen = vi.fn();
    await render(<UpdateBanner visible url="https://example.test/apk" onOpen={onOpen} />);
    expect(screen.getByText(/تحديث مطلوب/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("تحديث"));
    expect(onOpen).toHaveBeenCalledWith("https://example.test/apk");
  });
  it("renders nothing when not required", async () => {
    await render(<UpdateBanner visible={false} url="x" />);
    expect(screen.queryByTestId("update-banner")).toBeNull();
  });
});
