/**
 * The other half of `unsigned-tx.ts`: once a caller has signed the envelope `buildUnsignedTx`
 * returned, these submit it and report what the network made of it. Nothing here ever signs.
 */
import { TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
import type { NetworkConfig } from "@ballast/network-config";
import { normalizeContractValue } from "./scval.js";

/**
 * A transaction's hash covers its body and the network passphrase but not its signatures, so the
 * unsigned envelope a route hands out and the signed one that comes back share this value.
 */
export function txHashOf(envelopeXdr: string, networkPassphrase: string): string {
  return Buffer.from(TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase).hash()).toString("hex");
}

/** The decoded `TransactionResult` as compact JSON (it carries bigints), for an error message. */
function describe(errorResult: unknown): string {
  if (errorResult === undefined) return "no detail";
  try {
    return JSON.stringify(errorResult, (_key, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 300);
  } catch {
    return "undecodable result";
  }
}

/** Sends a signed envelope and returns its hash. Does not wait for it to close. */
export async function sendSignedTx(config: NetworkConfig, signedXdr: string): Promise<string> {
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
  const tx = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`contract-clients: network rejected the transaction (${describe(sent.errorResult)})`);
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw new Error("contract-clients: network is busy, try submitting again");
  }
  return sent.hash;
}

export type TxOutcome =
  | { status: "SUCCESS"; ledger: number; returnValue: unknown }
  | { status: "FAILED"; ledger: number }
  | { status: "NOT_FOUND" };

/**
 * One `getTransaction` read. `NOT_FOUND` means "not closed yet, or older than the RPC's retention
 * window" — the RPC can't tell those apart, so callers decide how long to keep asking.
 */
export async function getTxOutcome(config: NetworkConfig, hash: string): Promise<TxOutcome> {
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
  const got = await server.getTransaction(hash);
  if (got.status === "SUCCESS") {
    return {
      status: "SUCCESS",
      ledger: got.ledger,
      returnValue: got.returnValue ? normalizeContractValue(scValToNative(got.returnValue)) : undefined,
    };
  }
  if (got.status === "FAILED") {
    return { status: "FAILED", ledger: got.ledger };
  }
  return { status: "NOT_FOUND" };
}
