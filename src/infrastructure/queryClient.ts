import { QueryClient } from "@tanstack/react-query";
import { isAuthFailure } from "@/infrastructure/auth/TokenProvider";

let client: QueryClient | null = null;

/**
 * Shared QueryClient for the whole app.
 */
export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return new QueryClient();
  if (!client) {
    client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          gcTime: 5 * 60_000,
          refetchOnWindowFocus: true,
          retry: (failureCount, error) => {
            if (isAuthFailure(error)) return failureCount < 1;
            return failureCount < 2;
          },
          retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 3_000),
        },
        mutations: {
          retry: 0,
        },
      },
    });
  }
  return client;
}
