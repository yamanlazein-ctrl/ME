/**
 * Privacy filter for every Sentry event the API sends (`beforeSend`). The ERP's requests carry
 * bearer tokens, session cookies and money/customer payloads; none of that may leave the server,
 * whatever the SDK's defaults are in a given version.
 */
type ScrubbableEvent = {
  request?: { headers?: Record<string, string>; cookies?: unknown; data?: unknown; query_string?: unknown };
  user?: unknown;
};

const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-setup-token", "x-motard-runtime-token"]);

export function scrubSentryEvent<E extends ScrubbableEvent>(event: E): E {
  const req = event.request;
  if (req) {
    if (req.headers) {
      for (const k of Object.keys(req.headers)) if (SECRET_HEADERS.has(k.toLowerCase())) delete req.headers[k];
    }
    delete req.cookies;
    delete req.data; // request bodies hold invoices, payments, passwords
    delete req.query_string; // list filters can carry customer names
  }
  delete event.user;
  return event;
}
