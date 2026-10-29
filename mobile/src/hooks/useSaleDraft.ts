// The sale draft lives in memory only (a killed app loses it - a half-typed sale is not a document). One module-level store
// shared by the three sale screens.
import { useSyncExternalStore } from "react";
import { emptyDraft, type SaleDraft } from "../core/saleDraft";

let draft: SaleDraft = emptyDraft();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const saleDraftStore = {
  get: () => draft,
  set(next: SaleDraft) {
    draft = next;
    emit();
  },
  update(patch: Partial<SaleDraft>) {
    draft = { ...draft, ...patch };
    emit();
  },
  reset() {
    draft = emptyDraft();
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useSaleDraft(): SaleDraft {
  return useSyncExternalStore(saleDraftStore.subscribe, saleDraftStore.get, saleDraftStore.get);
}
