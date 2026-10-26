// Thin client for the FastAPI backend. The browser only talks to this app's origin:
// next.config.ts rewrites /api/v1/* to WB_API_URL, so the HttpOnly session cookie stays same-origin.

export const API_BASE = "/api/v1";

export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | null;
  requestId: string | null;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> | null, requestId: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export type ApiOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body,
      credentials: "same-origin",
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "The API could not be reached. Is the API server running (see the README)?", null, null);
  }
  const requestId = res.headers.get("x-request-id");
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const env = (data && typeof data === "object" ? (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error : null) ?? null;
    if (env?.code) {
      throw new ApiError(res.status, env.code, env.message ?? env.code, env.details ?? null, requestId);
    }
    if (res.status === 404 && typeof data === "object" && data && "detail" in data) {
      throw new ApiError(404, "not_found", String((data as { detail: unknown }).detail), null, requestId);
    }
    const fallback = res.status >= 500 && res.status < 600 && !text
      ? "The API is not reachable through the web server (is it running?)"
      : `Request failed with HTTP ${res.status}`;
    throw new ApiError(res.status, res.status === 502 || res.status === 503 ? "api_unavailable" : "http_error", fallback, null, requestId);
  }
  return data as T;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
