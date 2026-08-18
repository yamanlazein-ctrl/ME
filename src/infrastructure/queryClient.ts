import { QueryClient } from "@tanstack/react-query";

let client: QueryClient | null = null;

/**
 * Shared QueryClient for the whole app.
 */
export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return new QueryClient();
  if (!client) client = new QueryClient();
  return client;
}