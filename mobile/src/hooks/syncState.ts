// Pure part of the sync indicator (UX-03): the four states every screen shows.
export type SyncKind = "synced" | "pending" | "offline" | "attention";

export interface SyncChipState {
  kind: SyncKind;
  /** Units still waiting to be sent (also shown while offline). */
  pending: number;
}

export interface SyncInputs {
  online: boolean;
  pending: number;
  /** A rejected or dead document, or sync halted (version mismatch, revoked device, unknown device). */
  attention: boolean;
}

/** attention beats offline beats pending beats synced. */
export function deriveSyncState({ online, pending, attention }: SyncInputs): SyncChipState {
  if (attention) return { kind: "attention", pending };
  if (!online) return { kind: "offline", pending };
  if (pending > 0) return { kind: "pending", pending };
  return { kind: "synced", pending: 0 };
}

export function syncLabel(state: SyncChipState): string {
  switch (state.kind) {
    case "synced":
      return "تمت المزامنة";
    case "pending":
      return `بانتظار الإرسال (${state.pending})`;
    case "offline":
      return state.pending > 0 ? `غير متصل (${state.pending})` : "غير متصل";
    case "attention":
      return "يحتاج انتباهاً";
  }
}
