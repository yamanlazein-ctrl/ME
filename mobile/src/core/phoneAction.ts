import { getApp, type App } from "./appRuntime";
import { logError } from "./devlog";

type Phone = NonNullable<App["phone"]>;

export const NO_PHONE_MESSAGE = "الهاتف غير مرتبط بالمركز. افتح «المزيد» ثم المزامنة.";

/**
 * Runs a screen's write action on the phone and turns every failure into a message the screen shows.
 * Before, a thrown error became an unhandled rejection (the confirm sheet stayed open, nothing was said) and a
 * phone that was not ready returned silently.
 */
export async function runPhoneAction<T>(
  scope: string,
  action: (phone: Phone) => Promise<T>,
  setError: (message: string | null) => void,
): Promise<T | undefined> {
  setError(null);
  try {
    const app = await getApp();
    if (!app.phone) {
      setError(NO_PHONE_MESSAGE);
      return undefined;
    }
    return await action(app.phone);
  } catch (e) {
    setError(errorText(e));
    logError(scope, e);
    return undefined;
  }
}

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  // The use-case's own Arabic message; never SQL text or a stack.
  return raw && /[؀-ۿ]/.test(raw) ? raw : "تعذّر إتمام العملية. حاول مرة أخرى.";
}
