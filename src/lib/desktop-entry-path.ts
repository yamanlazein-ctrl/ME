/**
 * The desktop window loads Tauri's asset `_shell.html` (see APP_PAGE in
 * main.rs). TanStack Router then treats the pathname `/_shell.html` as a
 * missing route, so first-run onboarding succeeds and the next paint is the
 * English 404 page. Map that entry file back to `/` without a document reload.
 */
export function isDesktopShellPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return p === "/_shell.html" || p === "/index.html";
}

export function normalizeDesktopEntryPath(): boolean {
  if (typeof window === "undefined") return false;
  if (!isDesktopShellPath(window.location.pathname)) return false;
  const next = `/${window.location.search}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", next);
  return true;
}
