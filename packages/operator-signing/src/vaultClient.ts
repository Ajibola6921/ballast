/**
 * The HTTP side of the Vault signer: authentication that renews itself, request timeouts and
 * bounded retries. A long-running keeper or price publisher cannot hold one Vault token forever,
 * so with AppRole credentials this logs in on first use, renews the token before its lease runs
 * out, and logs in again if Vault stops accepting it. A static `VAULT_TOKEN` still works, but it
 * cannot be refreshed: when it expires the signer fails loudly instead of limping on.
 */

export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

export interface VaultAuthOptions {
  vaultAddr: string;
  /** A pre-issued token. Used as is; never renewed. */
  token?: string;
  /** AppRole credentials: exchanged for a short-lived token that this class keeps fresh. */
  roleId?: string;
  secretId?: string;
  /** Vault Enterprise namespace, sent as `X-Vault-Namespace`. */
  namespace?: string;
  fetchImpl?: typeof fetch;
  /** Overridable for tests. */
  now?: () => number;
}

interface AuthResponse {
  auth: { client_token: string; lease_duration: number; renewable: boolean };
}

export class VaultAuth {
  private token: string | undefined;
  private expiresAtMs = Number.POSITIVE_INFINITY;
  private renewAtMs = Number.POSITIVE_INFINITY;
  private renewable = false;
  private inFlight: Promise<void> | undefined;
  readonly vaultAddr: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: VaultAuthOptions) {
    this.vaultAddr = options.vaultAddr.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.token = options.token;
    if (!options.token && !(options.roleId && options.secretId)) {
      throw new Error("operator-signing: Vault needs either a token or an AppRole role id + secret id");
    }
  }

  get canRefresh(): boolean {
    return Boolean(this.options.roleId && this.options.secretId);
  }

  private headers(token?: string): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(token ? { "X-Vault-Token": token } : {}),
      ...(this.options.namespace ? { "X-Vault-Namespace": this.options.namespace } : {}),
    };
  }

  /** Headers for an authenticated call, renewing or logging in first when the lease is running out. */
  async authHeaders(): Promise<Record<string, string>> {
    if (this.canRefresh && (!this.token || this.now() >= this.renewAtMs)) await this.refresh();
    return this.headers(this.token);
  }

  /** Renews the current token if Vault allows, otherwise logs in again. Concurrent callers share one attempt. */
  async refresh(): Promise<void> {
    if (!this.canRefresh) throw new Error("operator-signing: the Vault token was rejected and cannot be refreshed (static VAULT_TOKEN)");
    this.inFlight ??= this.doRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    if (this.token && this.renewable && this.now() < this.expiresAtMs) {
      const renewed = await this.call("/v1/auth/token/renew-self", this.token).catch(() => undefined);
      if (renewed) return this.adopt(renewed);
    }
    const login = await this.call("/v1/auth/approle/login", undefined, {
      role_id: this.options.roleId,
      secret_id: this.options.secretId,
    });
    if (!login) throw new Error("operator-signing: Vault AppRole login failed");
    this.adopt(login);
  }

  private adopt(res: AuthResponse): void {
    this.token = res.auth.client_token;
    this.renewable = res.auth.renewable;
    const leaseMs = res.auth.lease_duration * 1000;
    // A lease of 0 means the token does not expire.
    this.expiresAtMs = leaseMs > 0 ? this.now() + leaseMs : Number.POSITIVE_INFINITY;
    this.renewAtMs = leaseMs > 0 ? this.now() + (leaseMs * 2) / 3 : Number.POSITIVE_INFINITY;
  }

  private async call(path: string, token: string | undefined, body?: unknown): Promise<AuthResponse | undefined> {
    const res = await this.fetchImpl(`${this.vaultAddr}${path}`, {
      method: "POST",
      headers: this.headers(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (path.endsWith("/login")) {
        throw new Error(`operator-signing: Vault AppRole login failed: ${res.status} ${await res.text()}`);
      }
      return undefined;
    }
    return (await res.json()) as AuthResponse;
  }
}

export interface VaultRequestOptions {
  retryDelayMs?: number;
}

/**
 * One Vault call with a timeout. Network errors, 429 and 5xx are retried (every call here is safe
 * to repeat: Ed25519 signing is deterministic and the rest are reads). A 403 or 401 triggers one
 * token refresh and a retry when the credentials allow it.
 */
export async function vaultFetch(
  auth: VaultAuth,
  path: string,
  init: { method?: string; body?: string } = {},
  fetchImpl: typeof fetch = fetch,
  { retryDelayMs = 250 }: VaultRequestOptions = {},
): Promise<Response> {
  let refreshed = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(`${auth.vaultAddr}${path}`, {
        ...init,
        headers: await auth.authHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if ((res.status === 403 || res.status === 401) && auth.canRefresh && !refreshed) {
        refreshed = true;
        await auth.refresh();
        attempt--; // the refresh is not a failed attempt
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        lastError = new Error(`Vault responded ${res.status}`);
      } else {
        return res;
      }
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
  }
  throw new Error(`operator-signing: Vault request ${path} failed after ${MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
