import { config } from "../config/env.js";

type AddressedRequest = {
  ip?: string;
  socket?: { remoteAddress?: string };
};

export function clientAddress(req: AddressedRequest): string | undefined {
  return req.ip ?? req.socket?.remoteAddress;
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const host = ip.replace(/^::ffff:/, "").split("%")[0];
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "0:0:0:0:0:0:0:1"
  );
}

/** Loopback, link-local, or RFC1918 / unique-local. */
export function isLocalOrPrivateLan(ip: string | undefined): boolean {
  if (!ip) return false;
  if (isLoopbackAddress(ip)) return true;
  const host = ip.replace(/^::ffff:/, "").split("%")[0];
  if (host.includes(".")) {
    if (host.startsWith("10.")) return true;
    if (host.startsWith("192.168.")) return true;
    if (host.startsWith("169.254.")) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  }
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

/**
 * True when this request is from the local desktop shell.
 *
 * Phase 1 bound the sidecar to `\\.\pipe\motard-erp`. Node leaves `req.ip`
 * undefined on named-pipe sockets, so a loopback-only check 401s every
 * first-run wizard POST (`تعذّر تهيئة التثبيت`). The pipe itself is
 * local-only (`.` namespace); treating a pipe-bound process as local is
 * the same trust boundary as 127.0.0.1 was on TCP.
 */
export function resolveDesktopLocalCaller(pipeBound: boolean, address: string | undefined): boolean {
  if (pipeBound) return true;
  return isLocalOrPrivateLan(address);
}

export function isDesktopLocalCaller(req: AddressedRequest): boolean {
  return resolveDesktopLocalCaller(Boolean(config.DESKTOP_PIPE), clientAddress(req));
}
