import type { IssuerAdapter } from "./adapter.js";
import { SpikoAdapter } from "./adapters/spikoAdapter.js";
import { EtherfuseAdapter } from "./adapters/etherfuseAdapter.js";
import { FranklinAdapter } from "./adapters/franklinAdapter.js";

/**
 * Resolves the `IssuerAdapter` for `issuerCode`. There is no mock mode: an issuer is served only
 * when its back-office is configured (`<ISSUER>_API_BASE_URL` + `<ISSUER>_API_KEY`, see
 * `.env.example`), and an unconfigured issuer throws rather than answering "approved".
 *
 * Adapters are built per issuer, on demand, so configuring one issuer does not require the others.
 *
 * NOTE: the SEP-8 leg follows the real documented Stellar "Regulated Assets" approval-server
 * protocol. The bespoke back-office endpoints (authorizations, liens, redemptions) are NOT
 * verified against any issuer's real API — none of Spiko, Etherfuse or Franklin publishes one —
 * and must be replaced with what each issuer provides under its integration agreement.
 */
export function getAdapter(issuerCode: string, env: NodeJS.ProcessEnv = process.env): IssuerAdapter {
  switch (issuerCode.toLowerCase()) {
    case "spiko":
      return new SpikoAdapter(
        env.SPIKO_API_BASE_URL ?? "",
        env.SPIKO_API_KEY ?? "",
        env.SPIKO_SEP8_APPROVAL_SERVER_URL,
      );
    case "etherfuse":
      return new EtherfuseAdapter(
        env.ETHERFUSE_API_BASE_URL ?? "",
        env.ETHERFUSE_API_KEY ?? "",
        env.ETHERFUSE_SEP8_APPROVAL_SERVER_URL,
      );
    case "franklin":
      return new FranklinAdapter(
        env.FRANKLIN_API_BASE_URL ?? "",
        env.FRANKLIN_API_KEY ?? "",
        env.FRANKLIN_SEP8_APPROVAL_SERVER_URL,
      );
    default:
      throw new Error(`issuer-gateway: no adapter registered for issuer code "${issuerCode}"`);
  }
}
