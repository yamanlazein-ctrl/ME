import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { EnrollView, type EnrollViewState } from "../../src/ui/EnrollView";
import { LoginView } from "../../src/ui/LoginView";
import {
  classifyEnrollError,
  ENROLL_ERROR_TEXT,
  hubRefusalText,
  normalizeHubUrl,
  parseEnrollQr,
  wakeHub,
} from "../../src/core/enrollFlow";
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
  it("shows the hub's own refusal text instead of the generic line", async () => {
    await render(
      <EnrollView
        state={{ ...base, error: "invalidCode", hubMessage: "انتهت صلاحية رمز التسجيل" }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        onScan={() => undefined}
      />,
    );
    expect(screen.getByText("انتهت صلاحية رمز التسجيل")).toBeTruthy();
    expect(screen.queryByText(ENROLL_ERROR_TEXT.invalidCode)).toBeNull();
  });
  it("offers a retry when the download stopped", async () => {
    const onRetry = vi.fn();
    await render(
      <EnrollView
        state={{ ...base, error: "stuck", progress: { percent: 1, applied: 40, headSeq: 0 } }}
        onChange={() => undefined}
        onSubmit={() => undefined}
        onScan={() => undefined}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("40 عملية")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("enroll-retry"));
    expect(onRetry).toHaveBeenCalledOnce();
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
    expect(classifyEnrollError(new EnrollmentRefusedError("x", "url"))).toBe("invalidUrl");
    expect(hubRefusalText(new EnrollmentRefusedError("رمز التسجيل غير صحيح", "login"))).toBe(
      "رمز التسجيل غير صحيح",
    );
    expect(hubRefusalText(new EnrollmentRefusedError("x", "reach"))).toBeNull();
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
    users: [
      { id: "u1", name: "سامر", role: "admin" as const, hasPin: true },
      { id: "u2", name: "ليلى", role: "accountant" as const, hasPin: false },
    ],
    selectedId: null as string | null,
    pin: "",
    pinStep: "enter" as const,
    error: null,
    busy: false,
    mode: "pin" as const,
    email: "",
    password: "",
    onSelect: () => undefined,
    onKey: () => undefined,
    onToggleMode: () => undefined,
    onChangeCredentials: () => undefined,
    onSubmit: () => undefined,
  };

  it("lists the users with their role and marks the one who still needs a PIN", async () => {
    const onSelect = vi.fn();
    await render(<LoginView {...props} onSelect={onSelect} />);
    expect(screen.getByText("مدير")).toBeTruthy();
    expect(screen.getByText("يحتاج رقماً سرياً")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("ليلى"));
    expect(onSelect).toHaveBeenCalledWith("u2");
  });

  it("the pad types, shows 4 dots and names the step", async () => {
    const onKey = vi.fn();
    await render(<LoginView {...props} selectedId="u1" pin="12" onKey={onKey} />);
    await fireEvent.press(screen.getByLabelText("7"));
    expect(onKey).toHaveBeenCalledWith("7");
    expect(screen.getByTestId("pin-dots").props.accessibilityLabel).toBe("2 من 4");
    expect(screen.getByTestId("pin-step").props.children).toContain("أدخل رقمك السري");
  });

  it("a user without a PIN is asked to choose one, then to confirm it", async () => {
    await render(<LoginView {...props} selectedId="u2" pinStep="choose" />);
    expect(screen.getByTestId("pin-step").props.children).toContain("اختر رقماً سرياً");
  });

  it("shows the hub's reason as an alert", async () => {
    await render(<LoginView {...props} selectedId="u1" error="الرقم السري غير صحيح" />);
    expect(screen.getByTestId("login-error")).toBeTruthy();
    expect(screen.getByText("الرقم السري غير صحيح")).toBeTruthy();
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

describe("hub address and wake-up", () => {
  it("normalises what people type", () => {
    expect(normalizeHubUrl("me-sh6t.onrender.com")).toBe("https://me-sh6t.onrender.com");
    expect(normalizeHubUrl("  https://me-sh6t.onrender.com/ ")).toBe(
      "https://me-sh6t.onrender.com",
    );
    expect(normalizeHubUrl("http://10.0.2.2:9")).toBe("http://10.0.2.2:9");
    expect(normalizeHubUrl("ftp://x.com")).toBeNull();
    expect(normalizeHubUrl("hello")).toBeNull();
    expect(normalizeHubUrl("")).toBeNull();
  });

  it("waits for a sleeping server, and gives up after the budget", async () => {
    let t = 0;
    let calls = 0;
    const deps = {
      fetch: (async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("Network request failed");
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
    expect(await wakeHub("https://h", deps)).toBe(true);
    expect(calls).toBe(3);
    const never = {
      ...deps,
      fetch: (async () => new Response("", { status: 502 })) as unknown as typeof fetch,
    };
    t = 0;
    expect(await wakeHub("https://h", never, 10_000)).toBe(false);
  });
});
