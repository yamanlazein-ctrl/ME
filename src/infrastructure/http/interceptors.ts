import type { HttpRequestConfig, HttpResponse, HttpInterceptor, TokenProvider } from "./types";

export function authInterceptor(tokenProvider: TokenProvider): HttpInterceptor {
  return {
    onRequest: async (config: HttpRequestConfig): Promise<HttpRequestConfig> => {
      const token = tokenProvider.getToken();
      if (token) {
        return {
          ...config,
          headers: { ...config.headers, Authorization: `Bearer ${token}` },
        };
      }
      return config;
    },
    onError: async (error) => {
      if (error.code === "UNAUTHORIZED" && tokenProvider.onTokenExpired) {
        const newToken = await tokenProvider.onTokenExpired();
        if (newToken) {
          error.retryable = true;
        }
      }
      return error;
    },
  };
}

export function tenantHeaderInterceptor(tenantId: string): HttpInterceptor {
  return {
    onRequest: async (config: HttpRequestConfig): Promise<HttpRequestConfig> => ({
      ...config,
      headers: { ...config.headers, "X-Tenant-Id": tenantId },
    }),
  };
}

export function loggingInterceptor(getToken?: () => string | null): HttpInterceptor {
  return {
    onRequest: async (config: HttpRequestConfig): Promise<HttpRequestConfig> => {
      console.debug(`[HTTP] ${config.method} ${config.path}`);
      return config;
    },
    onResponse: async <T>(response: HttpResponse<T>): Promise<HttpResponse<T>> => {
      console.debug(`[HTTP] ${response.status} ${response.statusText}`);
      return response;
    },
    onError: async (error) => {
      // A 401 while logged out (no token → session check /auth/me) is expected
      // on the login screen — don't spam the console with it. Real auth
      // failures (a token WAS present) are still surfaced.
      if (error.code === "UNAUTHORIZED" && getToken && !getToken()) {
        console.debug(`[HTTP] UNAUTHORIZED (no session) ${error.message}`);
      } else {
        console.error(`[HTTP] Error: ${error.code} ${error.message}`);
      }
      return error;
    },
  };
}
