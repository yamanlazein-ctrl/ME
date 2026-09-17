import type { ReactNode } from "react";
import { useEffect } from "react";
import { useCurrentUser } from "@/presentation/hooks/useAuth";
import { UserPickerPage } from "@/components/auth/UserPickerPage";
import { ensureDocumentFolders, isTauri } from "@/infrastructure/tauri-bridge";
import { clearTokens, hasStoredSession, isAuthFailure } from "@/infrastructure/auth/TokenProvider";

export function AuthGate({ children }: { children: ReactNode }) {
  const { data: user, isLoading, isFetching, isError, error, failureCount } = useCurrentUser();
  const sessionPresent = hasStoredSession();

  // Issue 12: on desktop login, ensure Desktop archive folders exist.
  useEffect(() => {
    if (!user || !isTauri()) return;
    void ensureDocumentFolders().catch((e) =>
      console.warn("[archive] ensure folders failed:", e),
    );
  }, [user]);

  // Stale JWT after DB wipe / setup reset — drop tokens so we leave the spinner.
  useEffect(() => {
    if (isError && isAuthFailure(error)) clearTokens();
  }, [isError, error]);

  // Hard stop: never spin forever. After retries settle with no user, show picker.
  const restoring =
    Boolean(sessionPresent && !user && !isError && (isLoading || isFetching)) &&
    failureCount < 2;

  if (restoring) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-background text-muted-foreground text-sm"
        dir="rtl"
        role="status"
        aria-live="polite"
      >
        جاري استعادة الجلسة…
      </div>
    );
  }
  if (!user) return <UserPickerPage />;
  return <>{children}</>;
}
