/**
 * Thin wrapper around `@stellar/stellar-sdk`'s Soroban RPC client (PRD §6.5: "CAP-67 events and
 * contract events over Stellar RPC"). Keeping this as a seam (rather than calling
 * `rpc.Server` directly from `poller.ts`) makes `pollOnce` easy to unit test with a mock.
 */
import { rpc, xdr } from "@stellar/stellar-sdk";

export interface EventFilter {
  /** Contract addresses (C...) to filter events for. */
  contractIds: string[];
  /** Optional topic filters — each entry is an OR'd list of base64 XDR `ScVal`s, `"*"` wildcard allowed. */
  topics?: string[][];
}

export interface RawChainEvent {
  /** The RPC's paging token for this event; pass the last one back as `cursor` for the next page. */
  id?: string;
  ledger: number;
  txHash: string;
  contractId: string;
  /** Topics, still `ScVal`-typed as returned by the RPC client (decoded by the caller via `scValToNative`). */
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

export interface GetEventsResult {
  events: RawChainEvent[];
  latestLedger: number;
}

export interface RpcClient {
  getEvents(args: {
    startLedger: number;
    filters: EventFilter[];
    limit?: number;
    /** Resume after this event id instead of from `startLedger` (the RPC accepts one or the other). */
    cursor?: string;
  }): Promise<GetEventsResult>;
  getLatestLedger(): Promise<{ sequence: number }>;
}

/**
 * Wraps `rpc.Server` (the SDK's Soroban RPC client, exposing the JSON-RPC `getEvents` and
 * `getLatestLedger` methods per https://developers.stellar.org/docs/data/rpc). Only the subset
 * this service needs is surfaced through `RpcClient`.
 */
export function createRpcClient(rpcUrl: string): RpcClient {
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

  return {
    async getEvents({ startLedger, filters, limit, cursor }) {
      const rpcFilters = filters.map((f) => ({
        type: "contract" as const,
        contractIds: f.contractIds,
        topics: f.topics,
      }));
      const response = await server.getEvents(
        cursor ? { cursor, filters: rpcFilters, limit } : { startLedger, filters: rpcFilters, limit },
      );

      return {
        latestLedger: response.latestLedger,
        events: response.events.map((e) => ({
          id: e.id,
          ledger: e.ledger,
          txHash: e.txHash,
          contractId: e.contractId ? e.contractId.toString() : "",
          topic: e.topic,
          value: e.value,
        })),
      };
    },

    async getLatestLedger() {
      const result = await server.getLatestLedger();
      return { sequence: result.sequence };
    },
  };
}
