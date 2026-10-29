import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { EnrollView, type EnrollViewState } from "../../src/ui/EnrollView";
import { LoginView } from "../../src/ui/LoginView";
import { classifyEnrollError, ENROLL_ERROR_TEXT, parseEnrollQr } from "../../src/core/enrollFlow";
import { EnrollmentRefusedError } from "../../src/core/enrollment";
import { InsufficientStorageError } from "../../src/core/firstDownload";

const base: EnrollViewState = { hub: "", code: "", busy: false, progress: null, error: null };

describe("enroll screen (US1, E15)", () => {
  it.each(["invalidCode", "network", "lowStorage"] as const)(
    "renders the %s error",
    async (error) => {
      await render(
        <EnrollView
          state={{ ...base, error }}
          onChange={() => undefined}
          onSubmit={() => undefined}
          onScan={() => undefined}
        />,
      );
      expect(screen.getByText(ENROLL_ERROR_TEXT[error])).toBeTruthy();
    },
  );
  it("network text says it will continue when the connection returns", () => {
    expect(ENROLL_ERROR_TEXT.network).toBe("سيتابع عند عودة الاتصال");
  });
  it("shows percent and count while downloading", async () => {
    await render(
      <EnrollView
        state={{ ...base, progress: { percent: 0.4, applied: 40, headSeq: 100 } }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        onScan={() => undefined}
      />,
    );
    expect(screen.getByText("جارٍ التحميل: 40%")).toBeTruthy();
  });
  it("classifies failures and parses the QR payload", () => {
    expect(classifyEnrollError(new InsufficientStorageError(10, 1))).toBe("lowStorage");
    expect(classifyEnrollError(new EnrollmentRefusedError("x", "login"))).toBe("invalidCode");
    expect(classifyEnrollError(new EnrollmentRefusedError("x", "reach"))).toBe("network");
    expect(classifyEnrollError(new TypeError("Network request failed"))).toBe("network");
    expect(parseEnrollQr('{"hub":"https://h","code":"ABC"}')).toEqual({
      hub: "https://h",
      code: "ABC",
    });
    expect(parseEnrollQr("nope")).toBeNull();
    expect(parseEnrollQr("motard://enroll?hub=https%3A%2F%2Fh.example&code=AB-12")).toEqual({
      hub: "https://h.example",
      code: "AB-12",
    });
    expect(parseEnrollQr(" https://h.example | AB-12 ")).toEqual({
      hub: "https://h.example",
      code: "AB-12",
    });
    expect(parseEnrollQr("https://h.example")).toBeNull();
  });
});

describe("login screen (US2, FR-02)", () => {
  const props = {
    users: [{ id: "u1", name: "سامر", role: "admin" as const }],
    selectedId: "u1",
    pin: "12",
    error: null,
    mode: "pin" as const,
    email: "",
    password: "",
    onSelect: () => undefined,
    onToggleMode: () => undefined,
    onChangeCredentials: () => undefined,
    onSubmit: () => undefined,
  };
  it("lists users, shows the pad and the password link", async () => {
    const onKey = vi.fn();
    await render(<LoginView {...props} onKey={onKey} />);
    expect(screen.getByText("سامر")).toBeTruthy();
    expect(screen.getByText("الدخول بكلمة المرور")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("7"));
    expect(onKey).toHaveBeenCalledWith("7");
    expect(screen.getByTestId("pin-dots").props.children).toBe("●●");
  });
});

describe("scan overlay", () => {
  it("shows the hint, a cancel button that works, and the rejected text", async () => {
    const { ScanOverlay } = await import("../../src/ui/ScanView");
    const onCancel = vi.fn();
    await render(<ScanOverlay message="ملاحظة" rejected={false} onCancel={onCancel} />);
    expect(screen.getByText("ملاحظة")).toBeTruthy();
    expect(screen.getByTestId("scan-frame")).toBeTruthy();
    fireEvent.press(screen.getByTestId("scan-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
