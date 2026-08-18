import { DomainError, NetworkError, mapHttpStatusToDomainError } from "@/core/errors";
import type {
  HttpMethod,
  HttpRequestConfig,
  HttpResponse,
  HttpInterceptor,
  RetryConfig,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY: RetryConfig = { maxRetries: 2, baseDelayMs: 300, maxDelayMs: 5_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(
  base: string | undefined,
  path: string | undefined,
  params?: Record<string, string>,
): string {
  let url = "";
  if (base) url += base.replace(/\/+$/, "");
  if (path) {
    const p = path.startsWith("/") ? path : `/${path}`;
    if (base && p.startsWith(base.replace(/\/+$/, ""))) {
      url = p;
    } else {
      url += p;
    }
  }
  if (!url) url = "/";
  if (params) {
    const clean = Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    );
    const qs = new URLSearchParams(clean as [string, string][]).toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  return url;
}

export class BaseHttpClient {
  private interceptors: HttpInterceptor[] = [];

  constructor(private defaultConfig: Partial<HttpRequestConfig> = {}) {}

  addInterceptor(interceptor: HttpInterceptor): void {
    this.interceptors.push(interceptor);
  }

  async request<T = unknown>(config: HttpRequestConfig): Promise<HttpResponse<T>> {
    return this.executeWithRetry<T>(config);
  }

  private async executeWithRetry<T>(config: HttpRequestConfig): Promise<HttpResponse<T>> {
    const retry = config.retry ?? DEFAULT_RETRY;
    let lastError: DomainError | null = null;

    // BUG-16 fix: generate one Idempotency-Key per logical mutating request and
    // reuse it across retries. The backend caches POST responses under this key
    // (Redis/in-memory, 5-min TTL), so a double-fire — double-click, network
    // retry after the server already committed — returns the cached response
    // instead of creating a duplicate record. GETs and DELETEs are excluded.
    const idempotencyKey =
      config.method !== "GET" && config.method !== "DELETE"
        ? (config.headers?.["Idempotency-Key"] as string | undefined) ??
          crypto.randomUUID()
        : undefined;

    for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
      // Apply request interceptors on every attempt so a refreshed token is
      // picked up on retries after a 401.
      let mergedConfig: HttpRequestConfig = {
        ...this.defaultConfig,
        ...config,
        headers: {
          ...this.defaultConfig.headers,
          ...config.headers,
          ...(idempotencyKey
            ? { "Idempotency-Key": idempotencyKey }
            : {}),
        },
      };
      for (const interceptor of this.interceptors) {
        if (interceptor.onRequest) {
          mergedConfig = await interceptor.onRequest(mergedConfig);
        }
      }

      try {
        const response = await this.executeSingle<T>(mergedConfig);
        let finalResponse: HttpResponse<T> = response;

        for (const interceptor of this.interceptors) {
          if (interceptor.onResponse) {
            finalResponse = await interceptor.onResponse(finalResponse);
          }
        }

        return finalResponse;
      } catch (err) {
        let domainErr = err instanceof DomainError ? err : new NetworkError("خطأ في الشبكة");
        lastError = domainErr;

        // Let interceptors observe/handle application errors (e.g. token
        // refresh on 401). An interceptor may mark the error retryable to
        // signal that a retry with the refreshed token is worthwhile.
        for (const interceptor of this.interceptors) {
          if (interceptor.onError) {
            domainErr = (await interceptor.onError(domainErr)) ?? domainErr;
          }
        }

        if (domainErr.retryable && attempt < retry.maxRetries) {
          // The auth interceptor refreshed the token (onTokenExpired) —
          // retry the request with the new token on the next attempt.
          const delay = Math.min(retry.baseDelayMs * Math.pow(2, attempt), retry.maxDelayMs);
          await sleep(delay);
          continue;
        }

        // Only retry network errors, not application errors
        if (domainErr.code !== "NETWORK") throw domainErr;
        if (attempt === retry.maxRetries) throw domainErr;

        const delay = Math.min(retry.baseDelayMs * Math.pow(2, attempt), retry.maxDelayMs);
        await sleep(delay);
      }
    }

    throw lastError ?? new NetworkError("فشل الاتصال");
  }

  private async executeSingle<T>(config: HttpRequestConfig): Promise<HttpResponse<T>> {
    const { body, timeoutMs, signal: externalSignal, method } = config;
    const url = buildUrl(config.baseUrl, config.path, config.params);

    const controller = new AbortController();
    const timeoutId =
      (timeoutMs ?? DEFAULT_TIMEOUT_MS)
        ? setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS)
        : undefined;

    const combinedSignal = externalSignal
      ? combineSignals(externalSignal, controller.signal)
      : controller.signal;

    try {
      const init: RequestInit = {
        method,
        headers: { "Content-Type": "application/json", ...config.headers },
        signal: combinedSignal,
      };

      if (body !== undefined && method !== "GET" && method !== "DELETE") {
        init.body = JSON.stringify(body);
      }

      const fetchResponse = await fetch(url, init);
      clearTimeout(timeoutId);

      const data = await parseResponseBody(fetchResponse);

      if (!fetchResponse.ok) {
        const message = extractErrorMessage(data) ?? fetchResponse.statusText;
        throw mapHttpStatusToDomainError(fetchResponse.status, data, message);
      }

      return {
        data: data as T,
        status: fetchResponse.status,
        statusText: fetchResponse.statusText,
        headers: fetchResponse.headers,
      };
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof DomainError) throw err;

      if (err instanceof DOMException && err.name === "AbortError") {
        throw new NetworkError("انتهت مهلة الطلب");
      }

      throw new NetworkError(
        err instanceof Error ? err.message : "خطأ في الاتصال",
        err instanceof Error ? err : undefined,
      );
    }
  }

  // Convenience methods
  get<T>(path: string, config?: Partial<HttpRequestConfig>): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "GET", path } as HttpRequestConfig);
  }

  post<T>(
    path: string,
    body?: unknown,
    config?: Partial<HttpRequestConfig>,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "POST", path, body } as HttpRequestConfig);
  }

  put<T>(
    path: string,
    body?: unknown,
    config?: Partial<HttpRequestConfig>,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "PUT", path, body } as HttpRequestConfig);
  }

  patch<T>(
    path: string,
    body?: unknown,
    config?: Partial<HttpRequestConfig>,
  ): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "PATCH", path, body } as HttpRequestConfig);
  }

  delete<T>(path: string, config?: Partial<HttpRequestConfig>): Promise<HttpResponse<T>> {
    return this.request<T>({ ...config, method: "DELETE", path } as HttpRequestConfig);
  }
}

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }
  const text = await response.text().catch(() => "");
  return text || null;
}

function extractErrorMessage(data: unknown): string | null {
  if (data && typeof data === "object") {
    if ("message" in data && typeof data.message === "string") return data.message;
    if ("error" in data && typeof data.error === "string") return data.error;
    if ("detail" in data && typeof data.detail === "string") return data.detail;
  }
  return null;
}
