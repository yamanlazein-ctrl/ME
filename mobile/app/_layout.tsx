// Root layout: providers, RTL check, splash (max 1.5 s), route guard, sync runner, app lock cover, and the status strip
// (sync chip + update banner) above every screen (FR-01, FR-04, FR-06, FR-07, FR-37, FR-41, UX-06).
import "../src/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { Stack, router, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as LocalAuthentication from "expo-local-authentication";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { getApp } from "../src/core/appRuntime";
import { authenticateWithBiometrics, coverVisible, shouldLock } from "../src/core/appLock";
import { readAppState, updateAppState } from "../src/core/appState";
import { isAllowedHere, routeFor } from "../src/core/routeGuard";
import { startSyncRunner } from "../src/core/syncRunner";
import { getSessionService } from "../src/core/sessionService";
import { useBoot } from "../src/hooks/useBoot";
import { useSyncState } from "../src/hooks/useSyncState";
import { useSyncStatus } from "../src/hooks/useSyncStatus";
import { AppLockOverlay } from "../src/ui/AppLockOverlay";
import { SyncChip } from "../src/ui/SyncChip";
import { ToastProvider } from "../src/ui/Toast";
import { UpdateBanner } from "../src/ui/UpdateBanner";
import { assertRtl } from "../src/ui/rtl";
import { verifyPin } from "../src/platform/pinVerifier";
import { getSecret } from "../src/platform/secureStore";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
const UPDATE_URL =
  process.env.EXPO_PUBLIC_UPDATE_URL ?? "https://github.com/yamanlazein-ctrl/me/actions";

function StatusStrip() {
  const chip = useSyncState();
  const status = useSyncStatus();
  return (
    <View style={{ paddingTop: 36 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", padding: 8 }}>
        <SyncChip state={chip} />
      </View>
      <UpdateBanner visible={status.halted === "versionMismatch"} url={UPDATE_URL} />
    </View>
  );
}

export default function RootLayout() {
  const boot = useBoot();
  const segments = useSegments();
  const [locked, setLocked] = useState(true);
  const [appStateName, setAppStateName] = useState(AppState.currentState);
  const cold = useRef(true);

  useEffect(() => {
    assertRtl();
    const timer = setTimeout(() => void SplashScreen.hideAsync().catch(() => undefined), 1_500);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (boot.ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [boot.ready]);

  // Route guard (FR-06, FR-07, FR-01).
  useEffect(() => {
    if (!boot.ready) return;
    const target = routeFor(boot);
    const current = `/${segments.join("/")}`;
    if (!isAllowedHere(current, target)) router.replace(target);
  }, [boot, segments]);

  // The sync loop runs while the phone is enrolled, the first download is done and someone is signed in.
  const active = boot.ready && boot.enrolled && boot.firstDownloadDone && boot.signedIn;
  useEffect(() => {
    if (!active) return;
    let stop: (() => void) | undefined;
    void getApp().then((app) => {
      if (app.phone && boot.session) {
        app.phone.setUser({
          id: boot.session.userId,
          name: boot.session.name,
          role: boot.session.role,
        });
        stop = startSyncRunner(app).stop;
      }
    });
    return () => stop?.();
  }, [active, boot.session]);

  // App lock (FR-04, FR-41).
  const evaluateLock = useCallback(async (coldStart: boolean) => {
    const state = await readAppState();
    setLocked(
      shouldLock({
        enabled: state.appLockEnabled,
        lastForegroundAt: state.lastForegroundAt,
        now: Date.now(),
        coldStart,
      }),
    );
  }, []);
  useEffect(() => {
    void evaluateLock(true);
    const sub = AppState.addEventListener("change", (next) => {
      setAppStateName(next);
      if (next === "active") {
        void evaluateLock(false);
      } else {
        void updateAppState({ lastForegroundAt: new Date().toISOString() });
      }
    });
    cold.current = false;
    return () => sub.remove();
  }, [evaluateLock]);

  const unlock = useCallback(async () => {
    if (await authenticateWithBiometrics(LocalAuthentication)) {
      await updateAppState({ lastForegroundAt: new Date().toISOString() });
      setLocked(false);
    }
  }, []);
  const unlockWithPin = useCallback(async (pin: string) => {
    const session = await (await getSessionService()).current();
    const verifier = session ? await getSecret(`pin.${session.userId}`) : null;
    if (!verifier || !(await verifyPin(pin, verifier))) return false;
    await updateAppState({ lastForegroundAt: new Date().toISOString() });
    setLocked(false);
    return true;
  }, []);
  const needsLock = locked && boot.ready && boot.signedIn;

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <StatusBar style="dark" />
        {active ? <StatusStrip /> : null}
        <Stack screenOptions={{ headerShown: false }} />
        <AppLockOverlay
          visible={coverVisible(appStateName ?? "active", needsLock)}
          onBiometric={unlock}
          onPin={unlockWithPin}
        />
      </ToastProvider>
    </QueryClientProvider>
  );
}
