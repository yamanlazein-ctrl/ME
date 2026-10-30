import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react-native";
import { deriveSyncState, syncLabel } from "../../src/hooks/syncState";
import { SyncChip, SyncChipFromInputs } from "../../src/ui/SyncChip";

describe("sync chip states (UX-03)", () => {
  it("derives the four states with the right priority", () => {
    expect(deriveSyncState({ online: true, pending: 0, attention: false }).kind).toBe("synced");
    expect(deriveSyncState({ online: true, pending: 3, attention: false })).toEqual({
      kind: "pending",
      pending: 3,
    });
    expect(deriveSyncState({ online: false, pending: 3, attention: false })).toEqual({
      kind: "offline",
      pending: 3,
    });
    expect(deriveSyncState({ online: false, pending: 3, attention: true }).kind).toBe("attention");
  });

  it("renders every state", async () => {
    for (const [inputs, kind, text] of [
      [{ online: true, pending: 0, attention: false }, "synced", "تمت المزامنة"],
      [{ online: true, pending: 4, attention: false }, "pending", "بانتظار الإرسال (4)"],
      [{ online: false, pending: 0, attention: false }, "offline", "غير متصل"],
      [{ online: true, pending: 0, attention: true }, "attention", "يحتاج انتباهاً"],
    ] as const) {
      await render(<SyncChipFromInputs {...inputs} />);
      expect(screen.getByTestId(`sync-chip-${kind}`)).toBeTruthy();
      expect(screen.getByText(text)).toBeTruthy();
    }
    await render(<SyncChip state={{ kind: "pending", pending: 1 }} />);
    expect(syncLabel({ kind: "offline", pending: 2 })).toBe("غير متصل (2)");
  });
});
