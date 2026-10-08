/**
 * Retries for the Soroban RPC calls every service makes. A public RPC endpoint drops connections
 * (`fetch failed`), answers from a node a ledger behind (`Account not found` for an account that
 * exists) and sheds load (429, 5xx, `TRY_AGAIN_LATER`); a single such answer should not fail a
 * draw, a liquidation or a price publish when the next attempt would succeed.
 *
 * Only transient failures are retried. A contract panic, a rejected transaction or a bad request is
 * a real answer and surfaces immediately. Resending a signed transaction is safe: the network
 * answers a duplicate with the original hash.
 */

const TRANSIENT =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network error|timed? ?out|Account not found|\b(429|500|502|503|504)\b|TRY_AGAIN_LATER|network is busy/i;

export function isTransientRpcError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message} ${(err.cause as Error | undefined)?.message ?? ""}` : String(err);
  return TRANSIENT.test(message);
}

export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  { attempts = 4, baseDelayMs = 400 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientRpcError(err) || attempt === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}
