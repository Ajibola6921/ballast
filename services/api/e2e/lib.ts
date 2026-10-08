/**
 * Shared plumbing for the end-to-end scripts in this directory. Each script plays the customers
 * against the running stack: real SEP-10 login, unsigned XDR from `services/api`, signed here
 * with the customer's own key (the API never sees a secret), handed back to `POST /v1/tx/submit`.
 * Run them through `scripts/e2e-services.sh` / `scripts/e2e-liquidation.sh`, which supply the env.
 */
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`e2e: ${name} is not set (run via the scripts/e2e-*.sh wrappers)`);
  return value;
}

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const PASSPHRASE = required("STELLAR_NETWORK_PASSPHRASE");

export const RWA_SAC = required("RWA_SAC");
export const lender = Keypair.fromSecret(required("LENDER_SECRET"));
export const borrower = Keypair.fromSecret(required("BORROWER_SECRET"));

/** One whole unit of a 7-decimal on-chain amount. */
export const UNIT = 10_000_000n;
export const units = (whole: number | bigint) => (BigInt(whole) * UNIT).toString();

export function step(message: string): void {
  console.log(`>>> ${message}`);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`e2e assertion failed: ${message}`);
}

export async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

function sign(xdr: string, keypair: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
  tx.sign(keypair);
  return tx.toXDR();
}

export interface Session {
  token: string;
  partyId: string;
}

export async function login(keypair: Keypair): Promise<Session> {
  const { transaction } = await call<{ transaction: string }>("POST", "/v1/auth/challenge", null, {
    account: keypair.publicKey(),
  });
  return call("POST", "/v1/auth/token", null, { transaction: sign(transaction, keypair) });
}

export interface Built {
  xdr: string;
  txHash: string;
}

/** Build -> sign locally -> submit through the API, and insist it settled. */
export async function act<T extends Built>(
  session: Session,
  keypair: Keypair,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const built = await call<T>(method, path, session.token, body);
  const settled = await call<{ status: string; txHash: string }>("POST", "/v1/tx/submit", session.token, {
    signedXdr: sign(built.xdr, keypair),
  });
  assert(settled.status === "settled", `${method} ${path} tx ${settled.txHash} is ${settled.status}`);
  assert(settled.txHash === built.txHash, "submitted hash matches the hash the API recorded");
  return built;
}

export async function waitFor<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5 * 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`e2e: timed out waiting for ${what}; last saw ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

export interface AssetRow {
  id: string;
  code: string;
  contractC: string;
  price: { value: string; status: string } | null;
}

export async function seededAsset(): Promise<AssetRow> {
  const { assets } = await call<{ assets: AssetRow[] }>("GET", "/v1/assets", null);
  const asset = assets.find((a) => a.contractC === RWA_SAC);
  assert(asset, `asset ${RWA_SAC} is seeded`);
  return asset;
}

export interface LineDetail {
  contractLineId: string | null;
  status: string;
  drawn: string;
  funded: string | null;
  collateralValue: string | null;
  priceStatus: string | null;
  ltvBps: number;
  marginState: string;
  undrawn: string | null;
  claimableInterest: string | null;
  liquidation: { closed: boolean; debt: string; recovered: string; surplus: string; shortfall: string } | null;
}

export function run(main: () => Promise<void>): void {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
