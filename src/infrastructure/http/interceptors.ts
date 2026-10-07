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

export function tenantHeaderInterceptor(getTenantId: () => string | null): HttpInterceptor {
  return {
    onRequest: async (config: HttpRequestConfig): Promise<HttpRequestConfig> => {
      const tenantId = getTenantId();
      if (!tenantId) return config;
      return {
        ...config,
        headers: { ...config.headers, "X-Tenant-Id": tenantId },
      };
    },
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

/** Every request names this device's sync identity (attribution of local writes). */
export function syncDeviceInterceptor(): HttpInterceptor {
  return {
    onRequest: async (config: HttpRequestConfig): Promise<HttpRequestConfig> => {
      let syncDeviceId: string | null = null;
      try {
        syncDeviceId = localStorage.getItem("erp.sync.deviceId");
      } catch {
        syncDeviceId = null;
      }
      return {
        ...config,
        headers: {
          ...config.headers,
          ...(syncDeviceId ? { "X-Sync-Device-Id": syncDeviceId } : {}),
        },
      };
    },
  };
}

/**
 * A business write (anything but a read, sync or auth call) is sent to the hub within
 * ~2 s instead of waiting for the next periodic sync — `schedule` debounces bursts.
 */
export function syncSoonInterceptor(schedule: () => void): HttpInterceptor {
  return {
    onRequest: (config: HttpRequestConfig): HttpRequestConfig => {
      const method = (config.method ?? "GET").toUpperCase();
      if (method !== "GET" && !/^\/?(api\/)?(sync|auth|health)(\/|$)/.test(config.path ?? "")) schedule();
      return config;
    },
  };
}
