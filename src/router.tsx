import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { getQueryClient } from "@/infrastructure/queryClient";
import { installDesktopTransport } from "./infrastructure/http/desktopTransport";
import { normalizeDesktopEntryPath } from "./lib/desktop-entry-path";

// Phase 1: on the desktop this must run before the router renders anything,
// because a route component can fire its first query on mount. Module scope
// is the only place guaranteed to be earlier than that; in the web build it is
// a no-op and `fetch` is left exactly as it was.
installDesktopTransport();
normalizeDesktopEntryPath();

export const getRouter = () => {
  normalizeDesktopEntryPath();
  const queryClient = getQueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
