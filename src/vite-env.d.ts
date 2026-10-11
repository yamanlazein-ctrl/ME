/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_API_TIMEOUT_MS: string;
  readonly VITE_REPO_MODE: string;
  readonly VITE_DEFAULT_TENANT_ID: string;
  readonly VITE_DESKTOP_DEPLOY?: string;
  /** Sentry DSN for the web build's crash reporting; unset = off. Never used on the desktop. */
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_DEFAULT_USER_ID: string;
  readonly VITE_DEFAULT_USER_NAME: string;
  readonly VITE_DEFAULT_USER_ROLE: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
