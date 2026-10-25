// Root layout: providers, RTL check, splash (max 1.5 s), route guard, sync runner, app lock cover, and the status strip
// (sync chip + update banner) above every screen (FR-01, FR-04, FR-06, FR-07, FR-37, FR-41, UX-06).
import "../src/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Image, View } from "react-native";
import logo from "../assets/logo.png";
import { Stack, router, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as LocalAuthentication from "expo-local-authentication";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusBar } from "expo-status-bar";
import { getApp } from "../src/core/appRuntime";
import { authenticateWithBiometrics, coverVisible, shouldLock } from "../src/core/appLock";
import { readAppState, updateAppState } from "../src/core/appState";
import { onUnlockedByLogin } from "../src/core/lockSignal";
import { isAllowedHere, routeFor } from "../src/core/routeGuard";
import { registerBackgroundSync } from "../src/core/backgroundSync";
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
import { installGlobalErrorLogging, logError } from "../src/core/devlog";
import { useAppFonts } from "../src/ui/fonts";
import { colors } from "../src/ui/theme";
import { ThemeProvider, useTheme } from "../src/ui/ThemeContext";
import { Text } from "../src/ui/Text";
import { verifyPin } from "../src/platform/pinVerifier";
import { getSecret } from "../src/platform/secureStore";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

installGlobalErrorLogging();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000 } },
  // A failed query is never silent: it goes to the device log with its key.
  queryCache: new QueryCache({
    onError: (error, query) => logError(`query ${JSON.stringify(query.queryKey)}`, error),
  }),
});
const UPDATE_URL =
  process.env.EXPO_PUBLIC_UPDATE_URL ?? "https://github.com/yamanlazein-ctrl/me/actions";

function StatusStrip() {
  const chip = useSyncState();
  const status = useSyncStatus();
  return (
    <View
      style={{
        paddingTop: 36,
        backgroundColor: colors.card,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          padding: 8,
        }}
      >
        <Image
          source={logo}
          style={{ width: 56, height: 28 }}
          resizeMode="contain"
          accessibilityLabel="Motard"
        />
        <SyncChip state={chip} />
      </View>
      <UpdateBanner visible={status.halted === "versionMismatch"} url={UPDATE_URL} />
    </View>
  );
}

function RootContent() {
  const fonts = useAppFonts();
  const { theme } = useTheme();
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
    if (fonts.error) logError("fonts", fonts.error);
  }, [fonts.error]);
  useEffect(() => {
    if (boot.ready && (fonts.loaded || fonts.error)) {
      void SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [boot.ready, fonts.loaded, fonts.error]);

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
        void registerBackgroundSync().catch(() => undefined);
      }
    });
    return () => stop?.();
  }, [active, boot.session]);

  // App lock (FR-04, FR-41).
  const evaluateLock = useCallback(async (coldStart: boolean) => {
    const state = await readAppState();
    const mustLock = shouldLock({
      enabled: state.appLockEnabled,
      lastForegroundAt: state.lastForegroundAt,
      now: Date.now(),
      coldStart,
    });
    // Only authentication lifts the lock: a later "active" event (Android sends one right after a cold start) must never
    // clear a lock that the cold start raised.
    setLocked((already) => already || mustLock);
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

  useEffect(
    () =>
      onUnlockedByLogin(() => {
        void updateAppState({ lastForegroundAt: new Date().toISOString() });
        setLocked(false);
      }),
    [],
  );

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
  // Cold start / resume lock: ask for the fingerprint straight away (FR-04); the PIN field stays as the fallback.
  const prompted = useRef(false);
  useEffect(() => {
    if (!needsLock) {
      prompted.current = false;
      return;
    }
    if (prompted.current) return;
    prompted.current = true;
    void unlock();
  }, [needsLock, unlock]);

  if (!fonts.loaded && !fonts.error)
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  if (fonts.error) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          padding: 24,
          justifyContent: "center",
        }}
      >
        <Text testID="fonts-error" style={{ fontSize: 20, marginBottom: 12 }}>
          تعذّر تحميل الخطوط والأيقونات
        </Text>
        <Text style={{ color: colors.negative }}>{fonts.error.message}</Text>
      </View>
    );
  }
  if (boot.bootError) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          padding: 24,
          justifyContent: "center",
        }}
      >
        <Text testID="boot-error" style={{ fontSize: 20, marginBottom: 12 }}>
          تعذّر تشغيل التطبيق
        </Text>
        <Text testID="boot-error-detail" style={{ color: colors.negative }}>
          {boot.bootError}
        </Text>
      </View>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <StatusBar style={theme === "dark" ? "light" : "dark"} />
          {active ? <StatusStrip /> : null}
          <Stack
            key={theme}
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          />
          <AppLockOverlay
            visible={coverVisible(appStateName ?? "active", needsLock)}
            onBiometric={unlock}
            onPin={unlockWithPin}
          />
        </View>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <RootContent />
    </ThemeProvider>
  );
}
