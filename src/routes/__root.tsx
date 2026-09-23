import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportError } from "../lib/error-reporting";
import { ThemeProvider } from "../components/theme-provider";
import { AuthGate } from "../components/auth/AuthGate";
import { ActivationGate } from "../components/activation/ActivationGate";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Toaster } from "../components/ui/sonner";
import { loadSettings } from "../presentation/hooks/useSettings";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

const TITLE = "نظام إدارة تجارة الأقمشة المتكامل";
const DESCRIPTION =
  "نظام ERP متخصص لتجار الأقمشة في سوريا — إدارة المخزون، المبيعات، الصندوق، والموردين بالكيلوغرام.";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#0a0a0a" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // Installable web app (PWA): Edge/Chrome "Install app" opens the web ERP in its own Windows window.
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/favicon.png?v=2", type: "image/png" },
      { rel: "icon", href: "/favicon.ico?v=2", type: "image/x-icon", sizes: "48x48" },
      { rel: "apple-touch-icon", href: "/favicon.png?v=2" },
      // FIN-12: the IBM Plex Sans Arabic webfont is self-hosted via
      // @fontsource (imported in styles.css). No remote font/style request is
      // issued, so the packaged desktop app renders correctly offline.
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Load persisted settings (company profile, manual exchange rates, ...) once
  // at boot so dashboards, prices and reports use real values across the app.
  useEffect(() => {
    void loadSettings();
  }, []);

  // Web deployment only: register the service worker that makes the app installable. The desktop shell
  // serves the same UI from its own local server and must not have a service worker of its own.
  useEffect(() => {
    if (
      import.meta.env.PROD &&
      import.meta.env.VITE_DESKTOP_DEPLOY !== "true" &&
      "serviceWorker" in navigator &&
      !("__TAURI_INTERNALS__" in window)
    ) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* installability is optional — never break the app over it */
      });
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {/* Provisioning gate first: an un-provisioned install must run the
            Setup Wizard (license activation) before any login screen. */}
        <ActivationGate>
          <AuthGate>
            {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
            <Toaster position="top-center" richColors closeButton />
          </AuthGate>
        </ActivationGate>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
