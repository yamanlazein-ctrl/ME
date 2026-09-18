/**
 * DFP-030 — resolve license-server bind host when loopback admin privilege is open.
 * Privileged openLoopback must never listen on a LAN/WAN address.
 */
export function resolveLicenseListenHost(
  openLoopback: boolean,
  requestedHost: string,
): { listenHost: string } {
  const host = (requestedHost || "0.0.0.0").trim();
  const requestedIsExplicitNonLoopback =
    host !== "127.0.0.1" &&
    host !== "::1" &&
    host !== "localhost" &&
    host !== "0.0.0.0" &&
    host !== "::";
  if (openLoopback && requestedIsExplicitNonLoopback) {
    throw new Error(
      `FATAL (DFP-030): LICENSE_ADMIN_OPEN_LOOPBACK cannot combine with HOST=${host}. ` +
        `Use 127.0.0.1 or set LICENSE_ADMIN_OPEN_LOOPBACK=0.`,
    );
  }
  return { listenHost: openLoopback ? "127.0.0.1" : host };
}
