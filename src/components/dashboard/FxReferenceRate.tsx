import { useCallback, useEffect, useRef, useState } from "react";
import { container } from "@/infrastructure/container";
import type { FxReferenceRateResponse } from "@/infrastructure/api";

/**
 * FxReferenceRate — the header's reference USD→SYP badge (DISPLAY-ONLY).
 *
 * ⛔ GOVERNING RULE (settled project decision — do not violate):
 * This component is a purely informational reference widget. It must NEVER be
 * imported by, rendered from, or connected to any invoice/voucher form, and
 * its value must NEVER pre-fill any `exchangeRate` field — users always type
 * the exchange rate manually on every invoice. It owns zero external state,
 * writes nowhere, and renders a self-contained badge. Nothing else.
 *
 * Design constraints implemented here:
 * - Backend-only data: the browser calls our internal endpoint
 *   GET /api/fx/reference-rate (server-cached); LiraScope is never
 *   contacted from the browser.
 * - Fully async and non-blocking: fetches in the background after mount;
 *   nothing on the page ever waits for this request.
 * - Graceful failure: on any error (timeout, backend down, provider down,
 *   schema drift) the badge degrades to a calm "غير متوفر حالياً" message,
 *   or keeps showing the last known rate flagged by its age. The page never
 *   breaks and no technical error is surfaced.
 * - Read-only presentation: plain badge (no input, no button semantics) so
 *   it can never suggest an editable field or invoice usage. The only
 *   interactive element is the required source attribution link.
 */

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // re-reads the backend's cached snapshot (backend refreshes upstream every 15 min)
const REFETCH_ON_VISIBLE_AFTER_MS = 5 * 60 * 1000;
const STALE_TINT_MS = 2 * 60 * 60 * 1000; // matches the backend stale threshold
const SOURCE_URL_FALLBACK = "https://lirascope.syria-cloud.sy";

function formatRate(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

/** "قبل ٥ د / قبل ساعة…" — always client-side, so no SSR hydration mismatch. */
function formatAgo(iso: string, nowMs: number): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  const ms = nowMs - parsed;
  if (ms < 60_000) return "الآن";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `قبل ${minutes} د`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "قبل ساعة" : `قبل ${hours} ساعة`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "قبل يوم" : `قبل ${days} يوم`;
}

export function FxReferenceRate() {
  const [snapshot, setSnapshot] = useState<FxReferenceRateResponse | null>(null);
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const inFlight = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await container.fx.api.getReferenceRate();
      if (alive.current) {
        setSnapshot(data);
        setFirstLoadDone(true);
        setNowMs(Date.now());
      }
    } catch {
      // Graceful: keep whatever we last had; the badge falls back to a calm
      // message. Never rethrows, never toasts, never breaks the page.
      if (alive.current) setFirstLoadDone(true);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const interval = setInterval(() => void load(), REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - nowMs > REFETCH_ON_VISIBLE_AFTER_MS
      ) {
        void load();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // ── First load: subtle placeholder, zero layout pressure, never blocks ──
  if (!firstLoadDone) {
    return (
      <div
        role="status"
        aria-label="جارٍ جلب السعر المرجعي"
        className="text-[12px] text-muted-foreground"
      >
        السعر المرجعي…
      </div>
    );
  }

  const rateValue = snapshot?.available === true ? snapshot.rate?.value : undefined;

  // ── Failure (or provider outage with nothing cached): calm fallback ──
  if (typeof rateValue !== "number") {
    return (
      <div
        role="status"
        aria-live="polite"
        title="تعذّر جلب السعر المرجعي حالياً — سيُعاد المحاولة تلقائياً. سعر الصرف في الفواتير يُدخل يدوياً كالمعتاد."
        className="text-[12px] text-muted-foreground"
      >
        السعر المرجعي غير متوفر
      </div>
    );
  }

  // ── Success: rate + mandatory source attribution + last-update age ──
  const stale =
    snapshot?.stale === true ||
    (snapshot?.fetchedAt ? nowMs - Date.parse(snapshot.fetchedAt) > STALE_TINT_MS : false);
  const ago = snapshot?.fetchedAt ? formatAgo(snapshot.fetchedAt, nowMs) : "";
  const sourceName = snapshot?.sourceName ?? "LiraScope";
  const sourceUrl = snapshot?.sourceUrl ?? SOURCE_URL_FALLBACK;
  const meta = [ago ? `آخر تحديث ${ago}` : stale ? "سعر قديم" : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="status"
      aria-live="polite"
      title="سعر مرجعي للعرض فقط — يُدخل سعر الصرف يدوياً في كل فاتورة"
      className="flex items-baseline gap-2 whitespace-nowrap"
    >
      <span
        className={
          stale
            ? "text-[12px] font-semibold tabular-nums text-warning"
            : "text-[12px] font-semibold tabular-nums text-foreground"
        }
      >
        <span dir="ltr">$1 = {formatRate(rateValue)}</span>
        <span className="ms-1 font-normal text-muted-foreground">ل.س</span>
      </span>
      <span className="text-[10px] text-muted-foreground">
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
        >
          {sourceName}
        </a>
        {meta ? <> · {meta}</> : null}
      </span>
    </div>
  );
}
