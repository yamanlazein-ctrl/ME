import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck, Upload } from "lucide-react";
import { getAccessToken } from "@/infrastructure/auth/TokenProvider";
import { isDesktopRuntime } from "@/infrastructure/http/desktopTransport";
import { pickBackupFile, type SavedBackupFile } from "@/infrastructure/tauri-bridge";

/**
 * Full restore from a portable backup (.zip, format v3).
 *
 *  - mode "settings": signed-in admin; the file is verified first and the
 *    current data is replaced only after a typed confirmation. The server
 *    takes an automatic safety backup of the replaced data.
 *  - mode "wizard": first run on a new machine (no users yet) — restores
 *    instead of creating a new company.
 *
 * The server does the whole restore in a staging database and swaps it in
 * with one transaction: on any error the current data is untouched.
 *
 * TWO hand-off paths, because the desktop SPA has no HTTP origin
 * -------------------------------------------------------------
 * On the desktop the SPA is embedded in the binary and reaches the API only over the Tauri IPC bridge,
 * whose request body is a `String`. A `File` cannot cross it: the patched `fetch` drops every non-string
 * body, so `fetch(url, { body: file })` arrives as ZERO bytes and the server answers "لم يصل أي ملف" for
 * a perfectly valid archive. The bridge is text-only by design, so here — exactly as the outbound backup
 * already does via `saveBackupFile` — the SHELL owns the file: the native dialog picks it
 * (`pickBackupFile`), the shell measures its size + sha256, and the restore goes to
 * `/api/backup/restore-path`, which re-verifies those from the file's own bytes. On the web the ordinary
 * octet-stream upload is used unchanged.
 */
const CONFIRM_PHRASE = "استبدل البيانات";

/** The archive chosen by the operator, on either hand-off path. */
type Picked = { kind: "upload"; file: File } | { kind: "path"; file: SavedBackupFile };

type Summary = {
  createdAt: string;
  appVersion: string;
  company: string | null;
  rows: number;
  schemaMigrations: number;
  rowsByTable: Record<string, number>;
};

export function FullRestoreCard({
  mode,
  onRestored,
}: {
  mode: "settings" | "wizard";
  onRestored: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [phrase, setPhrase] = useState("");
  const [state, setState] = useState<"idle" | "verifying" | "restoring" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const authHeaders = (): Record<string, string> => {
    const token = getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  /** Choose the archive: the native dialog on desktop (a `File` cannot cross the IPC bridge), the
   *  ordinary file input on the web. Resolves false when the user cancels, which changes nothing. */
  async function choose(): Promise<boolean> {
    setError(null);
    if (isDesktopRuntime()) {
      const chosen = await pickBackupFile().catch((e: unknown) => {
        setState("error");
        setError(e instanceof Error ? e.message : "تعذّر اختيار الملف");
        return null;
      });
      if (!chosen) return false;
      setPicked({ kind: "path", file: chosen });
      setSummary(null);
      setResult(null);
      return true;
    }
    inputRef.current?.click();
    return false; // the input's onChange continues the flow
  }

  async function verifyAndContinue(p: Picked) {
    if (mode === "wizard") return; // verified as part of the restore itself
    setState("verifying");
    try {
      const res =
        p.kind === "path"
          ? await fetch("/api/backup/verify-path", {
              method: "POST",
              headers: { ...authHeaders(), "Content-Type": "application/json" },
              body: JSON.stringify({ path: p.file.path, sha256: p.file.sha256, sizeBytes: p.file.sizeBytes }),
            })
          : await fetch("/api/backup/verify", {
              method: "POST",
              headers: { ...authHeaders(), "Content-Type": "application/octet-stream" },
              body: p.file,
            });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "تعذّر التحقق من الملف");
      setSummary(body as Summary);
      setState("idle");
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "تعذّر التحقق من الملف");
    }
  }

  async function pick(f: File) {
    const p: Picked = { kind: "upload", file: f };
    setPicked(p);
    setSummary(null);
    setError(null);
    setResult(null);
    await verifyAndContinue(p);
  }

  async function restore() {
    if (!picked) return;
    setState("restoring");
    setError(null);
    try {
      const byPath =
        picked.kind === "path"
          ? {
              body: JSON.stringify({
                path: picked.file.path,
                sha256: picked.file.sha256,
                sizeBytes: picked.file.sizeBytes,
              }),
              contentType: "application/json",
            }
          : { body: picked.file, contentType: "application/octet-stream" };
      const url =
        mode === "wizard"
          ? picked.kind === "path"
            ? "/api/setup/wizard/restore-path"
            : "/api/setup/wizard/restore"
          : picked.kind === "path"
            ? "/api/backup/restore-path?confirm=replace"
            : "/api/backup/restore?confirm=replace";
      const res = await fetch(url, {
        method: "POST",
        headers: { ...(mode === "settings" ? authHeaders() : {}), "Content-Type": byPath.contentType },
        body: byPath.body,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "فشلت الاستعادة — لم تتغير البيانات الحالية");
      const rows = (body.tables ?? []).reduce((a: number, t: { rows: number }) => a + t.rows, 0);
      setResult(
        `تمت الاستعادة والتحقق من ${rows.toLocaleString("ar")} سجل` +
          (body.schema?.migratedDuringRestore
            ? ` (رُقّيت النسخة ${body.schema.migratedDuringRestore} ترحيلات)`
            : "") +
          (body.safetyBackup ? `. نسخة أمان من البيانات السابقة: ${body.safetyBackup}` : ""),
      );
      setState("done");
      // Users were replaced by the backup's users: every session must sign in again.
      setTimeout(onRestored, 2500);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "فشلت الاستعادة");
    }
  }

  const fileName = picked?.kind === "path" ? picked.file.path.split(/[\\/]/).pop() ?? picked.file.path : picked?.file.name ?? null;
  const busy = state === "verifying" || state === "restoring";
  const canRestore =
    !!picked &&
    !busy &&
    state !== "done" &&
    (mode === "wizard" || (!!summary && phrase.trim() === CONFIRM_PHRASE));

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center gap-2 font-semibold">
        <ShieldCheck className="h-5 w-5 text-primary" />
        {mode === "wizard" ? "استعادة نسخة احتياطية من جهاز سابق" : "استعادة نسخة احتياطية كاملة"}
      </div>
      <p className="text-xs text-muted-foreground">
        {mode === "wizard"
          ? "بدل إنشاء شركة جديدة: اختر ملف النسخة (ZIP). تعود كل البيانات والمستخدمون بأرقامهم السرية كما كانت."
          : "تستبدل كل بيانات الشركة على هذا الجهاز بمحتوى النسخة. يُتحقق من الملف كاملاً أولاً، وتؤخذ نسخة أمان تلقائية من البيانات الحالية، وأي خطأ يُلغي العملية دون أي تغيير."}
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])}
      />
      <button
        type="button"
        disabled={busy || state === "done"}
        onClick={() => void choose()}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm hover:bg-secondary disabled:opacity-50"
      >
        <Upload className="h-4 w-4" />
        {fileName ? fileName : "اختر ملف النسخة الاحتياطية (.zip)"}
      </button>

      {state === "verifying" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> جاري التحقق من سلامة الملف…
        </p>
      )}

      {summary && (
        <div className="rounded-lg bg-muted/50 p-3 text-xs leading-6">
          <div>تاريخ النسخة: {new Date(summary.createdAt).toLocaleString("ar")}</div>
          <div>
            الشركة: {summary.company ?? "—"} · إصدار البرنامج: {summary.appVersion}
          </div>
          <div>
            السجلات: {summary.rows.toLocaleString("ar")} · الفواتير:{" "}
            {(summary.rowsByTable.invoices ?? 0).toLocaleString("ar")} · السندات:{" "}
            {(summary.rowsByTable.vouchers ?? 0).toLocaleString("ar")}
          </div>
          <div className="text-emerald-700">✓ الملف سليم (بصمات SHA-256 مطابقة)</div>
        </div>
      )}

      {mode === "settings" && summary && state !== "done" && (
        <label className="block text-xs">
          <span className="mb-1 block text-muted-foreground">
            للتأكيد اكتب: <strong>{CONFIRM_PHRASE}</strong>
          </span>
          <input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            className="w-full rounded-lg border bg-secondary px-3 py-2 text-sm outline-none focus:border-primary"
          />
        </label>
      )}

      {state === "restoring" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> جاري الاستعادة والتحقق… لا تغلق البرنامج
          (إغلاقه لا يُتلف البيانات، لكنه يلغي العملية).
        </p>
      )}
      {state === "done" && result && (
        <p className="flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {result}
        </p>
      )}
      {state === "error" && error && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}

      <button
        type="button"
        disabled={!canRestore}
        onClick={() => void restore()}
        className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-50"
      >
        {state === "restoring" ? "جاري الاستعادة…" : "استعادة"}
      </button>
    </div>
  );
}
