// Every request the page makes goes to its own origin: `/auth/*` for the
// lock, `/bff/v1/*` for the Opus Systems OS API (the server adds the key).
// Errors arrive in one envelope, ours or the API's alike.

export interface ErrorEnvelope {
  type: string;
  message: string;
  request_id?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly retryAfter: number | null;
  readonly requestId?: string;

  constructor(status: number, env: ErrorEnvelope, retryAfter: number | null) {
    super(env.message);
    this.status = status;
    this.type = env.type;
    this.retryAfter = retryAfter;
    this.requestId = env.request_id;
  }
}

/** Fired when any call comes back 401: the unlock expired or was revoked. */
export const LOCKED_EVENT = "jarvis:locked";

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "x-jarvis": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    let env: ErrorEnvelope = { type: "internal", message: res.statusText || `HTTP ${res.status}` };
    try {
      const json = await res.json();
      if (json?.error?.type) env = json.error;
    } catch {
      /* not JSON — keep the status text */
    }
    const ra = Number(res.headers.get("retry-after"));
    if (res.status === 401 && path.startsWith("/bff/")) {
      window.dispatchEvent(new CustomEvent(LOCKED_EVENT));
    }
    throw new ApiError(res.status, env, Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  return res;
}

export async function unlock(password: string): Promise<void> {
  await request("POST", "/auth/login", { password });
}

export async function lock(): Promise<void> {
  await request("POST", "/auth/logout").catch(() => undefined);
}

/** `/web/*`: this site's own small routes (the mic lease). */
export async function web<T>(path: string, body: unknown, keepalive = false): Promise<T> {
  if (keepalive) {
    // Unload-safe: fire and forget.
    void fetch(`/web/${path}`, {
      method: "POST",
      headers: { "x-jarvis": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
    return undefined as T;
  }
  const res = await request("POST", `/web/${path}`, body);
  return (await res.json()) as T;
}

export async function get<T>(apiPath: string): Promise<T> {
  const res = await request("GET", `/bff/v1/${apiPath}`);
  return (await res.json()) as T;
}

export async function post<T>(apiPath: string, body?: unknown): Promise<T> {
  const res = await request("POST", `/bff/v1/${apiPath}`, body ?? {});
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A binary body (a recording) with its own content type; JSON back. */
export async function postAudio<T>(apiPath: string, body: ArrayBuffer, contentType: string): Promise<T> {
  const res = await fetch(`/bff/v1/${apiPath}`, {
    method: "POST",
    headers: { "x-jarvis": "1", "content-type": contentType },
    body,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    let env: ErrorEnvelope = { type: "internal", message: res.statusText || `HTTP ${res.status}` };
    try {
      const json = await res.json();
      if (json?.error?.type) env = json.error;
    } catch {
      /* not JSON */
    }
    if (res.status === 401) window.dispatchEvent(new CustomEvent(LOCKED_EVENT));
    const ra = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, env, Number.isFinite(ra) && ra > 0 ? ra : null);
  }
  return (await res.json()) as T;
}

/** Raw response, for binary bodies (speech) and streams. */
export function raw(method: string, apiPath: string, body?: unknown): Promise<Response> {
  return request(method, `/bff/v1/${apiPath}`, body);
}

export interface Me {
  key_id: string;
  name: string;
  scopes: string[];
}
