/**
 * HTTP transport — a thin wrapper around `fetch` for REST-based source
 * adapters (Notion, Confluence, Linear, Google Drive, …).
 *
 * Why a shared utility?
 *   - Every REST adapter needs the same boilerplate: auth header,
 *     User-Agent, retry on 429/5xx, paginated collect, JSON parsing.
 *     Centralizing keeps each adapter under ~150 LOC of source-specific
 *     translation logic.
 *   - The `fetch` impl is injectable so tests can mock without touching
 *     the network. Node 22 has global `fetch`, so production callers
 *     pass nothing.
 */

export type FetchLike = typeof fetch;

export interface HttpClientOptions {
  /** Required: base URL for the API (e.g. `https://api.notion.com/v1`). */
  baseUrl: string;
  /**
   * Required: callable that returns the current auth headers. We
   * accept a function (rather than a static header) so OAuth tokens
   * can be refreshed transparently and so tests can inject a fixed
   * value without leaking the credential into the constructor.
   */
  authHeaders: () => Record<string, string> | Promise<Record<string, string>>;
  /** User-Agent string. Defaults to `atelier/<version>`. */
  userAgent?: string;
  /** Extra headers applied to every request. */
  defaultHeaders?: Record<string, string>;
  /**
   * Injected fetch. Defaults to the global. Tests pass a stub.
   */
  fetchImpl?: FetchLike;
  /**
   * Max retries on 429/5xx. Each retry waits `Retry-After` seconds
   * if the server provides it, otherwise an exponential backoff
   * starting at 500ms. Defaults to 3.
   */
  maxRetries?: number;
  /** Override the exponential base in milliseconds. Default 500. */
  retryBaseMs?: number;
  /** Sleep impl — replaced in tests so they don't actually wait. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    public readonly body: string
  ) {
    const snippet = body.length > 300 ? body.slice(0, 300) + "…" : body;
    super(`HTTP ${status} ${statusText} for ${url}: ${snippet}`);
    this.name = "HttpError";
  }
}

export interface HttpRequest {
  /** HTTP method. Defaults to GET. */
  method?: string;
  /** Path appended to baseUrl. Should start with `/`. */
  path: string;
  /** Query parameters. Values are stringified; `undefined`/`null` skipped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON-serializable body. */
  body?: unknown;
  /** Extra headers for this request. */
  headers?: Record<string, string>;
}

/**
 * Minimal HTTP client that REST adapters use. All convenience (auth,
 * retries, paginate-and-collect) belongs here so adapters don't
 * re-implement it.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
    if (!this.fetchImpl) {
      throw new Error(
        "HttpClient: no fetch implementation available — pass `fetchImpl` or run on Node 18+."
      );
    }
    this.sleepImpl =
      opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
  }

  /** Issue a request and parse the response as JSON. */
  async request<T = unknown>(req: HttpRequest): Promise<T> {
    const url = this.buildUrl(req);
    const baseHeaders: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.opts.userAgent ?? "atelier",
      ...(this.opts.defaultHeaders ?? {}),
      ...(req.headers ?? {}),
    };
    const auth = await this.opts.authHeaders();
    Object.assign(baseHeaders, auth);

    const init: RequestInit = {
      method: req.method ?? "GET",
      headers: baseHeaders,
    };
    if (req.body !== undefined) {
      baseHeaders["Content-Type"] = baseHeaders["Content-Type"] ?? "application/json";
      init.body = JSON.stringify(req.body);
    }

    let attempt = 0;
    while (true) {
      const response = await this.fetchImpl(url, init);
      if (response.ok) {
        return (await response.json()) as T;
      }
      // 429 + 5xx are retryable.
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const delayMs = retryAfter ?? this.retryBaseMs * 2 ** attempt;
        attempt++;
        await this.sleepImpl(delayMs);
        continue;
      }
      // Non-retryable error — throw with body for diagnostics.
      const text = await safeReadText(response);
      throw new HttpError(response.status, response.statusText, url, text);
    }
  }

  /**
   * Collect every page from a paginated endpoint.
   *
   * @param req            The base request (query/body for page 1).
   * @param itemsKey       Path into the response that holds the items
   *                       array (e.g. `["results"]`).
   * @param paginate       Source-specific: given the current response,
   *                       return the request shape to fetch the next
   *                       page, or `null` when done.
   * @param maxPages       Safety cap (default 100).
   */
  async paginate<TResponse = unknown, TItem = unknown>(
    req: HttpRequest,
    itemsKey: string[],
    paginate: (response: TResponse) => HttpRequest | null,
    maxPages = 100
  ): Promise<TItem[]> {
    let current: HttpRequest | null = req;
    let page = 0;
    const out: TItem[] = [];
    while (current && page < maxPages) {
      const resp = (await this.request(current)) as TResponse;
      const items = extractByPath(resp, itemsKey);
      if (Array.isArray(items)) out.push(...(items as TItem[]));
      current = paginate(resp);
      page++;
    }
    return out;
  }

  private buildUrl(req: HttpRequest): string {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
    let url = base + path;
    if (req.query) {
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (v === undefined || v === null) continue;
        usp.append(k, String(v));
      }
      const qs = usp.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    return url;
  }
}

/**
 * Parse the `Retry-After` header. RFC 7231 allows seconds OR an
 * HTTP-date; we support seconds and treat date form as "use default
 * backoff" since the rare cases that use it are usually upstream
 * outages we'd want to back off from anyway.
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = parseInt(value, 10);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  return null;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function extractByPath(obj: unknown, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

// ============================================================
// Credential resolution
// ============================================================

/**
 * Resolve a credential reference from `Source.credentials` to a live
 * secret string. Today only `{ envVar: "..." }` is supported. The
 * function is async to leave room for OS keychain integration later
 * (`{ keychain: "..." }`) without breaking callers.
 */
export async function resolveCredential(
  ref: { envVar: string } | undefined,
  context: { sourceId: string }
): Promise<string> {
  if (!ref) {
    throw new Error(
      `Source "${context.sourceId}" is missing credentials. Add \`credentials: { envVar: "..." }\` in sources.yaml or re-run \`atelier source onboard\`.`
    );
  }
  if (ref.envVar) {
    const value = process.env[ref.envVar];
    if (!value || value.length === 0) {
      throw new Error(
        `Source "${context.sourceId}" expected credential in $${ref.envVar} but the env var is empty.`
      );
    }
    return value;
  }
  throw new Error(
    `Source "${context.sourceId}" has an unsupported credential reference (only \`envVar\` is supported today).`
  );
}
