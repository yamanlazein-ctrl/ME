// The purchase draft lives in memory only, shared by the entry screens (same idea as the sale draft store).
import { useSyncExternalStore } from "react";
import { emptyEntryDraft, type EntryDraft } from "../core/entryDraft";

let draft: EntryDraft = emptyEntryDraft();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const entryDraftStore = {
  get: () => draft,
  update(patch: Partial<EntryDraft>) {
    draft = { ...draft, ...patch };
    emit();
  },
  reset() {
    draft = emptyEntryDraft();
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useEntryDraft(): EntryDraft {
  return useSyncExternalStore(entryDraftStore.subscribe, entryDraftStore.get, entryDraftStore.get);
}
