// What the root layout needs to decide where the user belongs: boots the app once and exposes enrolment/session facts.
import { useCallback, useEffect, useState } from "react";
import { getApp } from "../core/appRuntime";
import { getSessionService } from "../core/sessionService";
import type { GuardInput } from "../core/routeGuard";
import type { StoredSession } from "../core/session";

const listeners = new Set<() => void>();

/** Screens call this after enrolling, finishing the first download, signing in or out. */
export function notifyBootChanged(): void {
  listeners.forEach((l) => l());
}

export interface BootState extends GuardInput {
  ready: boolean;
  session: StoredSession | null;
  reload(): Promise<void>;
}

export function useBoot(): BootState {
  const [state, setState] = useState<Omit<BootState, "reload">>({
    ready: false,
    enrolled: false,
    firstDownloadDone: false,
    signedIn: false,
    session: null,
  });
  const reload = useCallback(async () => {
    const app = await getApp();
    const session = app.enrollment ? await (await getSessionService()).current() : null;
    setState({
      ready: true,
      enrolled: Boolean(app.enrollment),
      firstDownloadDone: Boolean(app.enrollment?.firstDownloadDone),
      signedIn: Boolean(session),
      session,
    });
  }, []);
  useEffect(() => {
    void reload();
    const listener = () => void reload();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [reload]);
  return { ...state, reload };
}
