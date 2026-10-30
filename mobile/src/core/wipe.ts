// Remote revoke + wipe (FR-40, constitution VII, E7). When the phone learns it was revoked it deletes its database, every
// `motard.` secure-store key, app-state.json and the cached PDFs, then returns to enrolment - even when unsent
// documents exist (lost-device policy). The steps run in this exact order; a step that fails does not stop the next ones.
export interface WipeDeps {
  closeAndDeleteDatabase(): Promise<void> | void;
  deleteSecrets(): Promise<void>;
  deleteAppState(): Promise<void>;
  deleteCachedPdfs(): Promise<void>;
  navigateToEnroll(): void;
}

export const WIPE_STEPS = ["database", "secrets", "app-state", "cached-pdfs", "navigate"] as const;

export async function wipeDevice(deps: WipeDeps): Promise<{ done: string[]; failed: string[] }> {
  const done: string[] = [];
  const failed: string[] = [];
  const step = async (name: (typeof WIPE_STEPS)[number], fn: () => Promise<void> | void) => {
    try {
      await fn();
      done.push(name);
    } catch {
      failed.push(name);
    }
  };
  await step("database", () => deps.closeAndDeleteDatabase());
  await step("secrets", () => deps.deleteSecrets());
  await step("app-state", () => deps.deleteAppState());
  await step("cached-pdfs", () => deps.deleteCachedPdfs());
  await step("navigate", () => deps.navigateToEnroll());
  return { done, failed };
}
