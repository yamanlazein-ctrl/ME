import type { DomainError } from "@/core/errors";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface HttpRequestConfig {
  baseUrl?: string;
  path?: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: RetryConfig;
}

export interface HttpResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export interface HttpInterceptor {
  onRequest?(config: HttpRequestConfig): HttpRequestConfig | Promise<HttpRequestConfig>;
  onResponse?<T>(response: HttpResponse<T>): HttpResponse<T> | Promise<HttpResponse<T>>;
  onError?(error: DomainError): DomainError | Promise<DomainError>;
}

export interface TokenProvider {
  getToken(): string | null;
  onTokenExpired?(): Promise<string | null>;
}
