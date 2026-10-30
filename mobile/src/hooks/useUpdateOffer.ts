import { useEffect, useState } from "react";
import Constants from "expo-constants";
import { getApp } from "../core/appRuntime";
import { readAppState, updateAppState } from "../core/appState";
import { logError } from "../core/devlog";
import { checkForUpdate, type UpdateOffer } from "../core/updateCheck";

/** Runs the once-a-day manifest check on the direct-APK channel when the phone is enrolled. */
export function useUpdateOffer(): UpdateOffer | null {
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const app = await getApp();
        const state = await readAppState();
        const code = Number(Constants.expoConfig?.android?.versionCode ?? 1);
        const result = await checkForUpdate(
          {
            channel: state.updateChannel,
            hubUrl: app.enrollment?.hubUrl ?? "",
            currentVersionCode: code,
            lastCheckAt: state.lastVersionCheckAt,
          },
          { fetch, now: () => new Date() },
        );
        if (result.checked) await updateAppState({ lastVersionCheckAt: new Date().toISOString() });
        if (!cancelled) setOffer(result.offer);
      } catch (e) {
        logError("update-check", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return offer;
}
