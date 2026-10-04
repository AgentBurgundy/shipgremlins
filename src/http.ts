// The one HTTP helper every real client uses: fetch + retry on 429/5xx with
// exponential backoff, and a typed error carrying the status and body so the
// clients can map specific refusals (a 405 merge, a 404 branch) to values.

export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string,
  ) {
    super(
      `${method} ${url} → ${status}${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }
  /** the body parsed as JSON, or null when it isn't JSON */
  json(): unknown {
    try {
      return JSON.parse(this.body);
    } catch {
      return null;
    }
  }
}

export interface RetryOptions {
  /** Injectable transport for provider contract tests. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** retries AFTER the first attempt (default 3) */
  retries?: number;
  /** base backoff, doubled per attempt (default 500ms); Retry-After wins when present */
  backoffMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const retryable = (status: number): boolean => status === 429 || status >= 500;

function retryDelay(
  res: Response | null,
  attempt: number,
  backoffMs: number,
): number {
  const header = res?.headers.get("retry-after");
  if (header !== null && header !== undefined && /^\d+$/.test(header)) {
    return Math.min(Number(header) * 1000, 30_000);
  }
  return backoffMs * 2 ** attempt;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const method = (init.method ?? "GET").toUpperCase();
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await (opts.fetch ?? fetch)(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(retryDelay(null, attempt, backoffMs));
      continue;
    }
    if (res.ok) return res;
    if (retryable(res.status) && attempt < retries) {
      await res.text().catch(() => "");
      await sleep(retryDelay(res, attempt, backoffMs));
      continue;
    }
    throw new HttpError(
      res.status,
      method,
      url,
      await res.text().catch(() => ""),
    );
  }
}

/** JSON in, JSON out; null for 204 / empty bodies. */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<T> {
  const res = await fetchWithRetry(url, init, opts);
  if (res.status === 204) return null as T;
  const text = await res.text();
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

export async function fetchText(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<string> {
  const res = await fetchWithRetry(url, init, opts);
  return res.text();
}
