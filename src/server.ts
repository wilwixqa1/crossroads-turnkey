import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { App, WITHDRAWAL_CAP } from "./app.js";
import { LocalVault, type Vault } from "./signer/index.js";
import { LedgerError, ASSETS, type Asset } from "./ledger/ledger.js";
import { requestMessage, type SignedRequest } from "./ledger/requests.js";
import { CHAINS } from "./chains/config.js";
import { loadState } from "./storage/state.js";

const here = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.STATE_PATH ?? join(process.cwd(), "data", "state.json");
const PORT = Number(process.env.PORT ?? 8080);

function buildVault(): Vault {
  const mode = process.env.VAULT_MODE ?? "local";
  if (mode === "local") {
    const mnemonic = process.env.LOCAL_VAULT_MNEMONIC;
    if (!mnemonic) throw new Error("LOCAL_VAULT_MNEMONIC is required in local mode (stand-in only; never real funds)");
    const known = loadState(STATE_PATH)?.ledger.accounts ?? {};
    return new LocalVault(mnemonic, Object.values(known).map((a) => a.depositAddress));
  }
  throw new Error(`VAULT_MODE=${mode} not implemented yet (Turnkey vault arrives in Phase 1)`);
}

const app = new App(buildVault(), STATE_PATH);
const server = Fastify({ logger: false });

// Serialize bigint anywhere in a response.
// NEXT PERSON: every bigint leaves the API as a decimal string. The page must never do arithmetic on
// these as JS numbers; parse to BigInt (or send back the string untouched).
server.setReplySerializer((payload) => JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

server.register(fastifyStatic, { root: join(here, "..", "public"), prefix: "/" });

server.setErrorHandler((rawErr, _req, reply) => {
  const err = rawErr as Error & { code?: string };
  const status = err instanceof LedgerError ? 400 : /Bad signature/.test(err.message) ? 401 : 500;
  reply.status(status).send({ error: err.message, code: err.code ?? "ERROR" });
});

server.get("/api/status", async () => ({
  vault: app.vault.describe(),
  assets: ASSETS,
  chains: CHAINS.map((c) => ({ asset: c.asset, chainId: c.chain.id, name: c.chain.name, confirmations: c.confirmations })),
  withdrawalCap: WITHDRAWAL_CAP.toString(),
  pool: app.ledger.state.pool.reserves,
  accounts: Object.keys(app.ledger.state.accounts).length,
}));

server.post<{ Body: { id: string; name: string } }>("/api/accounts", async (req) => {
  const { id, name } = req.body;
  if (!/^0x[0-9a-fA-F]{40}$/.test(id ?? "")) throw new LedgerError("id must be an address", "BAD_ID");
  if (!name?.trim()) throw new LedgerError("name required", "BAD_NAME");
  return app.signUp(id, name.trim().slice(0, 40));
});

server.get<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
  const acct = app.ledger.getAccount(req.params.id);
  return { ...acct, events: app.ledger.eventsFor(acct.id) };
});

/** The exact text a client must sign for a request; keeps client and server in step. */
server.post<{ Body: Omit<SignedRequest, "signature"> }>("/api/requests/message", async (req) => {
  const { account, seq, action, params } = req.body;
  return { message: requestMessage(account, seq, action, params) };
});

server.post<{ Body: SignedRequest }>("/api/requests", async (req) => app.handleRequest(req.body));

server.get<{ Querystring: { assetIn: Asset; assetOut: Asset; amount: string } }>("/api/quote", async (req) => {
  const { assetIn, assetOut, amount } = req.query;
  return { amountOut: app.ledger.quote(assetIn, assetOut, BigInt(amount)).toString() };
});

server.get<{ Querystring: { account?: string } }>("/api/hood", async (req) => {
  const acct = req.query.account?.toLowerCase();
  return app.hood.filter((h) => !acct || !h.account || h.account === acct).slice(-100).reverse();
});

server.get("/api/proof", async () => ({
  vault: app.vault.describe(),
  solvency: await app.solvency(),
  withdrawals: Object.values(app.ledger.state.withdrawals).slice(-20).reverse(),
}));

server.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  app.start();
  console.log(`Crossroads demo listening on :${PORT} — ${app.vault.describe()}`);
});

process.on("SIGTERM", () => {
  app.stop();
  server.close().then(() => process.exit(0));
});
