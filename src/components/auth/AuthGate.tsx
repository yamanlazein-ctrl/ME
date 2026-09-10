import type { ReactNode } from "react";
import { useEffect } from "react";
import { useCurrentUser } from "@/presentation/hooks/useAuth";
import { UserPickerPage } from "@/components/auth/UserPickerPage";
import { ensureDocumentFolders, isTauri } from "@/infrastructure/tauri-bridge";
import { hasStoredSession } from "@/infrastructure/auth/TokenProvider";

export function AuthGate({ children }: { children: ReactNode }) {
  const { data: user, isLoading, isFetching } = useCurrentUser();
  const sessionPresent = hasStoredSession();

  // Issue 12: on desktop login, ensure Desktop archive folders exist.
  useEffect(() => {
    if (!user || !isTauri()) return;
    void ensureDocumentFolders().catch((e) =>
      console.warn("[archive] ensure folders failed:", e),
    );
  }, [user]);

  // Issue 18: while restoring a stored session (incl. soft retries), hold the gate.
  // Tokens are NOT cleared on transient errors — only picker after retries settle.
  if (isLoading || (sessionPresent && !user && isFetching)) return null;
  if (!user) return <UserPickerPage />;
  return <>{children}</>;
}
