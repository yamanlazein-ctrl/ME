/**
 * Paper print readiness: window.print() must wait for the logo/fonts (with a
 * hard cap), and a double click must produce one print job, not two.
 * Runs in the node environment with a minimal fake DOM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("react-dom", () => ({ flushSync: (fn: () => void) => fn() }));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => {}, unmount: () => {} }),
}));
vi.mock("@tanstack/react-query", () => ({ QueryClientProvider: () => null }));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));
vi.mock("@/infrastructure/queryClient", () => ({ getQueryClient: () => ({}) }));
vi.mock("@/presentation/hooks/useInventory", () => ({ refreshInventory: async () => {} }));
vi.mock("@/presentation/hooks/useSettings", () => ({ settings: { company: {} } }));
vi.mock("@/infrastructure/tauri-bridge", () => ({
  isTauri: () => false,
  archiveDocumentPdf: vi.fn(),
  ensureDocumentFolders: vi.fn(),
}));

type Listener = () => void;
class FakeImg {
  complete = false;
  private listeners: Record<string, Listener[]> = {};
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string) {
    this.complete = true;
    for (const fn of this.listeners[type] ?? []) fn();
  }
}

let pendingImg: FakeImg;
const printSpy = vi.fn();

function installFakeDom() {
  const el = () => ({
    dataset: {} as Record<string, string>,
    style: { cssText: "" },
    id: "",
    textContent: "",
    setAttribute() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: (sel: string) => (sel === "img" ? [pendingImg] : []),
  });
  const g = globalThis as Record<string, unknown>;
  g.HTMLElement = class {};
  g.document = {
    title: "app",
    fonts: { ready: Promise.resolve() },
    createElement: el,
    body: { appendChild() {} },
    head: { appendChild() {} },
    getElementById: () => null,
    documentElement: { dataset: {}, removeAttribute() {} },
  };
  g.window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener() {},
    matchMedia: () => ({ addEventListener() {} }),
    print: printSpy,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  printSpy.mockReset();
  pendingImg = new FakeImg();
  installFakeDom();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("printDocument readiness + double-click guard", () => {
  it("does not print until the logo has loaded", async () => {
    const { printDocument } = await import("./printPortal");
    printDocument("doc");
    await vi.advanceTimersByTimeAsync(1000);
    expect(printSpy).not.toHaveBeenCalled();
    pendingImg.fire("load");
    await vi.advanceTimersByTimeAsync(0);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("prints anyway once the asset timeout elapses", async () => {
    const { printDocument, PRINT_ASSET_TIMEOUT_MS } = await import("./printPortal");
    printDocument("doc");
    await vi.advanceTimersByTimeAsync(200 + PRINT_ASSET_TIMEOUT_MS + 10);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("a second click while printing is ignored", async () => {
    const { printDocument } = await import("./printPortal");
    const { toast } = await import("sonner");
    pendingImg.complete = true;
    printDocument("doc");
    printDocument("doc");
    await vi.advanceTimersByTimeAsync(500);
    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith("الطباعة جارية");
  });
});

describe("print logo", () => {
  it("is inlined as a base64 data URI", async () => {
    const { default: logo } = await import("@/assets/logo-motard-icon.png?inline");
    expect(logo.startsWith("data:image/png;base64,")).toBe(true);
  });
});
