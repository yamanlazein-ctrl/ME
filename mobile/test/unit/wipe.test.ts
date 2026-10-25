import { describe, expect, it } from "vitest";
import { wipeDevice, type WipeDeps } from "../../src/core/wipe";

describe("wipeDevice (T081)", () => {
  it("deletes the database, every secret, app-state.json and cached PDFs, then goes to enrolment - in that order", async () => {
    const log: string[] = [];
    const deps: WipeDeps = {
      closeAndDeleteDatabase: async () => void log.push("database"),
      deleteSecrets: async () => void log.push("secrets"),
      deleteAppState: async () => void log.push("app-state"),
      deleteCachedPdfs: async () => void log.push("cached-pdfs"),
      navigateToEnroll: () => void log.push("navigate"),
    };
    const result = await wipeDevice(deps);
    expect(log).toEqual(["database", "secrets", "app-state", "cached-pdfs", "navigate"]);
    expect(result).toEqual({ done: log, failed: [] });
  });

  it("a failing step is reported but never stops the remaining ones (lost-device policy)", async () => {
    const log: string[] = [];
    const result = await wipeDevice({
      closeAndDeleteDatabase: async () => {
        throw new Error("file busy");
      },
      deleteSecrets: async () => void log.push("secrets"),
      deleteAppState: async () => void log.push("app-state"),
      deleteCachedPdfs: async () => void log.push("cached-pdfs"),
      navigateToEnroll: () => void log.push("navigate"),
    });
    expect(result.failed).toEqual(["database"]);
    expect(log).toEqual(["secrets", "app-state", "cached-pdfs", "navigate"]);
  });
});
