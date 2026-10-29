import { beforeEach, describe, expect, it, vi } from "vitest";

const scheduled: Array<{ content: { title: string; body: string } }> = [];
let granted = false;
const requestPermissionsAsync = vi.fn(async () => ({ granted: true }));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(async () => ({ granted })),
  requestPermissionsAsync: (...a: unknown[]) => requestPermissionsAsync(...(a as [])),
  scheduleNotificationAsync: vi.fn(
    async (n: { content: { title: string; body: string } }) => void scheduled.push(n),
  ),
}));

import { planNotifications, sendNotices } from "../../src/core/notify";

beforeEach(() => {
  scheduled.length = 0;
  granted = false;
  requestPermissionsAsync.mockClear();
});

describe("notifications (T074)", () => {
  it("one notification per newly rejected document, naming its number", () => {
    const plan = planNotifications({
      newRejected: ["INV-2026-0007", "VOC-2026-0003"],
      lowStockNow: [],
      alreadyAnnouncedLowStock: new Set(),
      pulledChanges: false,
    });
    expect(plan.map((n) => n.kind)).toEqual(["rejected", "rejected"]);
    expect(plan[0]?.body).toContain("INV-2026-0007");
    expect(plan[1]?.body).toContain("VOC-2026-0003");
  });

  it("one notification when sync stops, for each stop reason", () => {
    for (const stopped of ["versionMismatch", "revoked", "unknownDevice"] as const) {
      const plan = planNotifications({
        newRejected: [],
        stopped,
        lowStockNow: [],
        alreadyAnnouncedLowStock: new Set(),
        pulledChanges: false,
      });
      expect(plan).toHaveLength(1);
      expect(plan[0]?.kind).toBe("stopped");
    }
  });

  it("announces fabrics below minStockKg only after a pull that changed data, and only once", () => {
    const base = {
      newRejected: [],
      lowStockNow: ["قطن", "حرير"],
      alreadyAnnouncedLowStock: new Set(["حرير"]),
    };
    expect(planNotifications({ ...base, pulledChanges: false })).toHaveLength(0);
    const plan = planNotifications({ ...base, pulledChanges: true });
    expect(plan).toHaveLength(1);
    expect(plan[0]?.body).toContain("قطن");
    expect(plan[0]?.body).not.toContain("حرير");
  });

  it("asks for permission on first use and sends immediately", async () => {
    await sendNotices(
      planNotifications({
        newRejected: ["INV-1"],
        lowStockNow: [],
        alreadyAnnouncedLowStock: new Set(),
        pulledChanges: false,
      }),
    );
    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    await sendNotices([]);
    expect(scheduled).toHaveLength(1);
  });
});
