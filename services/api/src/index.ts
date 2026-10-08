import "./bigint-json.js";
import { createLogger } from "@ballast/observability";
import { loadApiConfig } from "./config.js";
import { buildServer } from "./server.js";
import { getChainGateway } from "./chain.js";
import { getContractClients } from "./contract-clients.js";
import { getDb } from "./db.js";
import { sweepPendingIntents } from "./intents.js";

const logger = createLogger("api");
const config = loadApiConfig();
const db = getDb();
const contracts = getContractClients();
const chain = getChainGateway();
const app = buildServer({ config, db, contracts, chain });

const SWEEP_INTERVAL_MS = Number(process.env.API_INTENT_SWEEP_MS ?? 15_000);
let sweeping = false;
setInterval(async () => {
  if (sweeping) return; // a slow RPC shouldn't stack sweeps on top of each other
  sweeping = true;
  try {
    const tally = await sweepPendingIntents(db, chain, contracts);
    if (tally.settled + tally.failed + tally.expired + tally.errors > 0) {
      logger.info(tally, "intent sweep changed pending transactions");
    }
  } catch (err) {
    logger.error({ err }, "intent sweep failed");
  } finally {
    sweeping = false;
  }
}, SWEEP_INTERVAL_MS).unref();

app.addHook("onResponse", async (request, reply) => {
  logger.info(
    { method: request.method, url: request.url, statusCode: reply.statusCode },
    "request completed",
  );
});

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then((address) => logger.info({ address }, "services/api listening"))
  .catch((err) => {
    logger.error({ err }, "services/api failed to start");
    process.exit(1);
  });
