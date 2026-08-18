import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertEnv(name: string, value: string | undefined): asserts value is string {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

/**
 * Creates a Supabase client with the anon key.
 * Safe for use in browser/server contexts that interact with Row Level Security policies.
 */
export function createAnonClient(): SupabaseClient {
  assertEnv("VITE_SUPABASE_URL", supabaseUrl);
  assertEnv("VITE_SUPABASE_ANON_KEY", supabaseAnonKey);

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });
}

/**
 * Creates a Supabase client with the service role key.
 * ⚠️ Must only be used in secure server-side contexts.
 * Bypasses Row Level Security.
 */
export function createServiceRoleClient(): SupabaseClient {
  assertEnv("VITE_SUPABASE_URL", supabaseUrl);
  assertEnv("SUPABASE_SERVICE_ROLE_KEY", supabaseServiceRoleKey);

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/**
 * Singleton anon client for convenience.
 * Prefer creating a fresh client per request in SSR/server contexts.
 */
export const supabaseAnon = createAnonClient();

/**
 * Singleton service-role client for convenience.
 * Only available in server contexts where the service role key is present.
 */
export const supabaseServiceRole = createServiceRoleClient();
