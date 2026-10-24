/**
 * Phase 1 — what the Google Drive account card shows (pure, so it is testable without rendering).
 *
 * The shell (google.rs `status`) is the only source of connection truth. The backend's last upload
 * time is shown only while the link is connected: a stale timestamp after a disconnect would
 * suggest a backup is still being made.
 */
import type { GoogleShellStatus } from "@/lib/drive-archive";

export type DriveAccountView =
  | { kind: "unavailable" } // the shell has no client to link with (no bundled and no override)
  | { kind: "connect"; canConnect: true } // configured, not linked: one-click connect
  | { kind: "connected"; email: string | null; source: "bundled" | "override" | null };

export function driveAccountView(shell: GoogleShellStatus | undefined): DriveAccountView | null {
  if (!shell) return null;
  if (shell.connected) {
    return { kind: "connected", email: shell.email || null, source: shell.source };
  }
  if (!shell.configured) return { kind: "unavailable" };
  return { kind: "connect", canConnect: true };
}

/** The advanced client form is offered only when no bundled client exists or the admin already overrode it. */
export function showAdvancedClientForm(shell: GoogleShellStatus | undefined): boolean {
  if (!shell) return false;
  return !shell.configured || shell.source === "override";
}
