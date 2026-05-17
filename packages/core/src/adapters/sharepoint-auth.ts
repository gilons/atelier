/**
 * Token providers for the SharePoint adapter.
 *
 * Atelier's first SharePoint flow accepted a static bearer token,
 * which works for a one-off sync but expires hourly — forcing the
 * user to re-paste a fresh token every time. This module replaces
 * that pattern with a small {@link TokenProvider} abstraction:
 *
 *   - {@link BearerTokenProvider} wraps a static token (the legacy
 *     "I pasted az's output into an env var" shape). No refresh,
 *     no caching — fails outright once the token expires.
 *
 *   - {@link AzureClientCredentialsProvider} holds a tenant id +
 *     client id + secret and mints fresh access tokens against
 *     Microsoft's token endpoint on demand. Tokens are cached in
 *     memory until ~60 seconds before they expire, then minted
 *     fresh. The user never sees a token; they enter the app
 *     credentials once and Atelier handles the rest.
 *
 * Both providers expose the same `getToken(): Promise<string>` API.
 * The SharePoint adapter's HttpClient authHeaders calls into that
 * for every Graph request, so refresh is transparent to the rest
 * of the codebase.
 */

const DEFAULT_GRAPH_SCOPE = "https://graph.microsoft.com/.default";
/**
 * Refresh tokens this many seconds before their stated expiry.
 * Microsoft's tokens are ~3600s; a 60-second skew keeps long sync
 * runs from racing a token that expires mid-call.
 */
const REFRESH_SKEW_SECONDS = 60;

export interface TokenProvider {
  /**
   * Return a valid Graph bearer token. May mint a fresh one on
   * first call or after expiry; idempotent + cheap within the
   * cache window.
   */
  getToken(): Promise<string>;
}

/** Static token. No refresh. */
export class BearerTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {
    if (!token || token.length === 0) {
      throw new Error("BearerTokenProvider requires a non-empty token.");
    }
  }
  getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
}

export interface AzureClientCredentialsOptions {
  /** Microsoft Entra tenant id (a GUID). */
  tenantId: string;
  /** App (client) id from App registrations. */
  clientId: string;
  /** The client secret VALUE (not the Secret ID). */
  clientSecret: string;
  /**
   * OAuth scope to request. Defaults to
   * `https://graph.microsoft.com/.default` — the right value for
   * a SharePoint / Files app calling Microsoft Graph.
   */
  scope?: string;
  /**
   * Injected for tests so we don't need a live Azure tenant.
   * Defaults to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Injected for tests to make cache expiry deterministic. */
  now?: () => number;
}

/**
 * Mints + caches tokens via the OAuth 2.0 client_credentials
 * flow. Cache is in-memory and per-instance: a fresh process will
 * mint on first use, subsequent calls within the same TTL hit
 * cache. We deliberately don't persist tokens to disk — they're
 * cheap to mint and persisting them is a misuse risk
 * (file-permissions, leaks via backup, etc.).
 *
 * The client_credentials grant assumes the app has been admin-
 * consented to its Graph permissions. If consent is missing,
 * Microsoft returns AADSTS65001 / similar; the error surfaces
 * verbatim so the user can see what went wrong.
 */
export class AzureClientCredentialsProvider implements TokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  /**
   * In-flight mint promise. Stored so that multiple concurrent
   * `getToken()` callers during a cold start share one mint call
   * instead of fanning out to N parallel POSTs against Microsoft.
   */
  private minting: Promise<string> | null = null;

  constructor(private readonly opts: AzureClientCredentialsOptions) {
    if (!opts.tenantId || !opts.clientId || !opts.clientSecret) {
      throw new Error(
        "AzureClientCredentialsProvider requires tenantId, clientId, and clientSecret."
      );
    }
  }

  async getToken(): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.token;
    }
    if (this.minting) return this.minting;
    this.minting = this.mint(now).finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  private async mint(now: number): Promise<string> {
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.opts.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: this.opts.scope ?? DEFAULT_GRAPH_SCOPE,
      grant_type: "client_credentials",
    });
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await resp.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Azure token endpoint returned non-JSON (${resp.status}): ${text.slice(0, 200)}`
      );
    }
    if (!resp.ok) {
      // Surface Microsoft's structured error verbatim — its
      // error_description usually tells you exactly what's wrong
      // (missing consent, bad secret, wrong tenant, etc.).
      const e = data as { error?: string; error_description?: string };
      throw new Error(
        `Azure token mint failed: ${e.error_description ?? e.error ?? `${resp.status} ${resp.statusText}`}`
      );
    }
    const d = data as { access_token?: string; expires_in?: number };
    if (typeof d.access_token !== "string" || d.access_token.length === 0) {
      throw new Error(
        `Azure token endpoint returned no access_token. Body: ${text.slice(0, 200)}`
      );
    }
    const expiresIn = typeof d.expires_in === "number" ? d.expires_in : 3600;
    this.cached = {
      token: d.access_token,
      expiresAt: now + (expiresIn - REFRESH_SKEW_SECONDS) * 1000,
    };
    return d.access_token;
  }
}

/**
 * Build a token provider from a {@link Source.credentials} value.
 * Splits on the discriminator: a `{kind: "azureClientCredentials"}`
 * record yields the auto-refreshing provider; an `{envVar}`
 * record yields the legacy bearer provider. Reads the
 * `clientSecretEnvVar` from `process.env` (or the supplied env
 * map) just-in-time so the secret never appears in sources.yaml.
 */
export function buildTokenProviderFromCredentials(
  credentials: unknown,
  context: { sourceId: string; env?: Record<string, string | undefined> }
): TokenProvider {
  const env = context.env ?? (process.env as Record<string, string | undefined>);
  if (!credentials || typeof credentials !== "object") {
    throw new Error(
      `Source "${context.sourceId}" is missing credentials. Re-run \`atelier source onboard\`.`
    );
  }
  const c = credentials as Record<string, unknown>;
  if (c.kind === "azureClientCredentials") {
    const tenantId = stringField(c.tenantId, "tenantId", context.sourceId);
    const clientId = stringField(c.clientId, "clientId", context.sourceId);
    const secretEnvVar = stringField(
      c.clientSecretEnvVar,
      "clientSecretEnvVar",
      context.sourceId
    );
    const secret = env[secretEnvVar];
    if (!secret) {
      throw new Error(
        `Source "${context.sourceId}" expects the Azure client secret in $${secretEnvVar} but the env var is empty.`
      );
    }
    return new AzureClientCredentialsProvider({
      tenantId,
      clientId,
      clientSecret: secret,
      scope: typeof c.scope === "string" ? c.scope : undefined,
    });
  }
  if (typeof c.envVar === "string") {
    const token = env[c.envVar];
    if (!token) {
      throw new Error(
        `Source "${context.sourceId}" expected bearer token in $${c.envVar} but the env var is empty.`
      );
    }
    return new BearerTokenProvider(token);
  }
  throw new Error(
    `Source "${context.sourceId}" has an unsupported credential shape. Expected \`{envVar}\` or \`{kind:"azureClientCredentials",...}\`.`
  );
}

function stringField(v: unknown, name: string, sourceId: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `Source "${sourceId}" credentials.${name} must be a non-empty string.`
    );
  }
  return v;
}
