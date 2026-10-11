import * as Sentry from "@sentry/react";

type SentryEnv = { VITE_SENTRY_DSN?: string; VITE_DESKTOP_DEPLOY?: string; MODE?: string };

/**
 * Browser crash reporting for the WEB build. Off unless `VITE_SENTRY_DSN` is set at build time.
 *
 * Never on the desktop build: it is offline-first and its CSP (`connect-src 'self' ipc:`) allows
 * no external connection, so events could not leave anyway; enabling it there is a CSP and
 * privacy decision, not a config value.
 *
 * Errors only, no PII, no tracing or session replay: an ERP screen shows customer and money data.
 * Hands Sentry to `reportError` (error-reporting.ts) through its existing `window.__errorReporter`
 * hook; Sentry's own handlers catch uncaught errors and unhandled rejections.
 */
export function initSentry(env: SentryEnv = import.meta.env): boolean {
  if (typeof window === "undefined") return false;
  const dsn = env.VITE_SENTRY_DSN?.trim();
  if (!dsn || env.VITE_DESKTOP_DEPLOY === "true") return false;
  Sentry.init({ dsn, environment: env.MODE, sendDefaultPii: false });
  window.__errorReporter = {
    captureException: (error, context) => Sentry.captureException(error, { extra: context }),
  };
  return true;
}
