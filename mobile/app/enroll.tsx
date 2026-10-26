// Enrolment (FR-07, FR-08, E15): QR or typed hub URL + code, then the resumable first download with progress.
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { getApp } from "../src/core/appRuntime";
import { classifyEnrollError, parseEnrollQr } from "../src/core/enrollFlow";
import { enroll, saveEnrollment } from "../src/core/enrollment";
import { runFirstDownload } from "../src/core/firstDownload";
import { deviceFirstDownloadDeps } from "../src/core/firstDownloadDeps";
import { notifyBootChanged } from "../src/hooks/useBoot";
import { EnrollView, type EnrollViewState } from "../src/ui/EnrollView";
import { ScanDenied, ScanOverlay } from "../src/ui/ScanView";

const RETRY_MS = 15_000;

export default function Enroll() {
  const [state, setState] = useState<EnrollViewState>({
    hub: "",
    code: "",
    busy: false,
    progress: null,
    error: null,
  });
  const [scanning, setScanning] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const download = useCallback(async () => {
    const app = await getApp();
    if (!app.phone || !app.enrollment) return;
    try {
      const result = await runFirstDownload({
        ...deviceFirstDownloadDeps(app.phone),
        onProgress: (p) =>
          setState((s) => ({
            ...s,
            progress: { percent: p.percent, applied: p.applied, headSeq: p.headSeq },
          })),
      });
      if (result.done) {
        await saveEnrollment({ ...app.enrollment, firstDownloadDone: true });
        app.enrollment = { ...app.enrollment, firstDownloadDone: true };
        notifyBootChanged();
      } else {
        setState((s) => ({ ...s, error: "other" }));
      }
    } catch (e) {
      const kind = classifyEnrollError(e);
      setState((s) => ({ ...s, error: kind, busy: false }));
      // A lost connection resumes by itself; the cursor is persisted after every page.
      if (kind === "network") retry.current = setTimeout(() => void download(), RETRY_MS);
    }
  }, []);

  // An enrolled phone with an unfinished download resumes here (FR-07).
  useEffect(() => {
    void getApp().then((app) => {
      if (app.enrollment && !app.enrollment.firstDownloadDone) {
        setState((s) => ({ ...s, progress: { percent: 0, applied: 0, headSeq: 0 } }));
        void download();
      }
    });
    return () => {
      if (retry.current) clearTimeout(retry.current);
    };
  }, [download]);

  const submit = async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const app = await getApp();
      const enrollment = await enroll(app.runtime, app.conn, {
        hubUrl: state.hub.trim(),
        code: state.code,
      });
      app.attach(enrollment);
      setState((s) => ({ ...s, busy: false, progress: { percent: 0, applied: 0, headSeq: 0 } }));
      await download();
    } catch (e) {
      setState((s) => ({ ...s, busy: false, error: classifyEnrollError(e) }));
    }
  };

  if (scanning && permission && !permission.granted && !permission.canAskAgain) {
    return <ScanDenied onCancel={() => setScanning(false)} />;
  }
  if (scanning) {
    return (
      <View style={{ flex: 1 }}>
        <CameraView
          style={{ flex: 1 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            const parsed = parseEnrollQr(data);
            if (parsed) {
              setScanning(false);
              setRejected(false);
              setState((s) => ({ ...s, hub: parsed.hub, code: parsed.code, error: null }));
            } else {
              setRejected(true);
            }
          }}
        />
        <ScanOverlay
          rejected={rejected}
          message={
            rejected
              ? "هذا الرمز ليس رمز تسجيل. اعرض رمز «أجهزة الشركة» من إعدادات المزامنة في برنامج الحاسوب"
              : "وجّه الكاميرا نحو رمز QR المعروض في برنامج الحاسوب (الإعدادات ← المزامنة السحابية ← أجهزة الشركة)"
          }
          onCancel={() => {
            setScanning(false);
            setRejected(false);
          }}
        />
      </View>
    );
  }
  return (
    <EnrollView
      state={state}
      onChange={(patch) => setState((s) => ({ ...s, ...patch }))}
      onSubmit={() => void submit()}
      onScan={() => {
        void (async () => {
          setRejected(false);
          if (!permission?.granted) await requestPermission();
          setScanning(true);
        })();
      }}
    />
  );
}
