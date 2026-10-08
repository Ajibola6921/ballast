// Signs a PriceGuard NAV reading the way services/price-guard's relay does, for scripts that
// publish prices by hand. Prints the 64-byte Ed25519 signature as hex.
//
//   node scripts/sign-nav.mjs <publisher secret S...> <asset code> <ts> <scaled value>
//
// The signed message is `${assetCode}:${ts}:${value}` (UTF-8), the same canonical message as
// services/price-guard/src/navSignature.ts and PriceGuard.publish_nav on-chain.
import { createRequire } from "node:module";

const require = createRequire(new URL("../services/price-guard/", import.meta.url));
const { Keypair } = require("@stellar/stellar-sdk");

const [secret, assetCode, ts, value] = process.argv.slice(2);
if (!secret || !assetCode || !ts || !value) {
  console.error("usage: sign-nav.mjs <secret> <asset code> <ts> <scaled value>");
  process.exit(2);
}
const sig = Keypair.fromSecret(secret).sign(Buffer.from(`${assetCode}:${ts}:${value}`, "utf8"));
console.log(Buffer.from(sig).toString("hex"));
