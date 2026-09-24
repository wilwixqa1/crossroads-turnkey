import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { english, generateMnemonic } from "viem/accounts";
import { App, WITHDRAWAL_CAP } from "./app.js";
import { LocalVault, type Vault } from "./signer/index.js";
import { TurnkeyVault, loadOrCreateAppKeys, readVaultOrgId } from "./signer/turnkey.js";
import { LedgerError, ASSETS, type Asset, type LedgerEvent } from "./ledger/ledger.js";
import { requestMessage, type SignedRequest } from "./ledger/requests.js";
import { CHAINS, chainFor } from "./chains/config.js";
import { loadState } from "./storage/state.js";
import { UserDirectory, loadOrCreateSignupKey, SESSION_SECONDS } from "./auth/google.js";

const here = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.STATE_PATH ?? join(process.cwd(), "data", "state.json");
const PORT = Number(process.env.PORT ?? 8080);
const VAULT_MODE = process.env.VAULT_MODE ?? "local";
const LIQUIDITY_PROVIDER = process.env.LIQUIDITY_PROVIDER?.trim().toLowerCase() || undefined;
/** google: Continue with Google, one Turnkey wallet per user. standin: a test key kept in the browser (laptop work). */
const LOGIN_MODE = process.env.LOGIN_MODE ?? "standin";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() || undefined;

/**
 * The stand-in vault's key phrase: made once at random and kept beside the saved state. A fixed phrase
 * would put every deposit address in public view (the well-known test phrases are swept by bots on
 * public testnets), and a fresh state folder gets a fresh phrase automatically.
 */
function localMnemonic(): string {
  const path = join(dirname(STATE_PATH), "local-vault-mnemonic.txt");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const phrase = generateMnemonic(english);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, phrase + "\n", { mode: 0o600 });
  return phrase;
}

async function buildVault(): Promise<Vault> {
  const mode = VAULT_MODE;
  const known = Object.values(loadState(STATE_PATH)?.ledger.accounts ?? {}).map((a) => a.depositAddress);
  if (mode === "local") {
    const mnemonic = process.env.LOCAL_VAULT_MNEMONIC?.trim() || localMnemonic();
    return new LocalVault(mnemonic, known, WITHDRAWAL_CAP);
  }
  if (mode === "turnkey") {
    const dir = dirname(STATE_PATH);
    const organizationId = process.env.TURNKEY_VAULT_ORG_ID?.trim() || readVaultOrgId(dir);
    if (!organizationId) throw new Error("No Turnkey vault yet: run `npm run turnkey:setup` first");
    const vault = await TurnkeyVault.open(
      { organizationId, keys: loadOrCreateAppKeys(dir), cap: WITHDRAWAL_CAP, chainIds: CHAINS.map((c) => c.chain.id) },
      (line) => console.log(line),
    );
    const held = new Set(await vault.addresses());
    const stray = known.filter((a) => !held.has(a));
    if (stray.length) throw new Error(`The saved ledger has ${stray.length} deposit address(es) this Turnkey vault does not hold. Use a fresh STATE_PATH for a new vault.`);
    return vault;
  }
  throw new Error(`Unknown VAULT_MODE=${mode} (use local or turnkey)`);
}

function buildDirectory(): UserDirectory | undefined {
  if (LOGIN_MODE === "standin") return undefined;
  if (LOGIN_MODE !== "google") throw new Error(`Unknown LOGIN_MODE=${LOGIN_MODE} (use google or standin)`);
  const parentOrg = process.env.TURNKEY_ORG_ID?.trim();
  if (!parentOrg || !GOOGLE_CLIENT_ID) throw new Error("LOGIN_MODE=google needs TURNKEY_ORG_ID and GOOGLE_CLIENT_ID");
  return UserDirectory.open(parentOrg, signupKey!);
}

const signupKey = LOGIN_MODE === "google" ? loadOrCreateSignupKey(dirname(STATE_PATH)) : undefined;
const directory = buildDirectory();
const app = new App(await buildVault(), STATE_PATH, { liquidityProvider: LIQUIDITY_PROVIDER });
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
  mode: VAULT_MODE,
  vault: app.vault.describe(),
  vaultLabel: app.vault.label,
  assets: ASSETS,
  chains: CHAINS.map((c) => ({ asset: c.asset, chainId: c.chain.id, name: c.chain.name, confirmations: c.confirmations, head: app.heads[c.asset] ?? null })),
  withdrawalCap: WITHDRAWAL_CAP.toString(),
  // The sign-up key's public half is shown so Will can register it with the one-time sign-up setup.
  login: { mode: LOGIN_MODE, googleClientId: GOOGLE_CLIENT_ID ?? null, signupPublicKey: signupKey?.publicKey ?? null, sessionSeconds: SESSION_SECONDS },
  liquidityProvider: LIQUIDITY_PROVIDER ?? null,
  pool: app.ledger.state.pool.reserves,
  accounts: Object.keys(app.ledger.state.accounts).length,
}));

/** Adds display names and an explorer link so the page never has to look either up. */
function decorate(e: LedgerEvent) {
  const nameOf = (id: unknown) => (typeof id === "string" ? app.ledger.state.accounts[id]?.name : undefined);
  const txHash = typeof e.detail.txHash === "string" ? e.detail.txHash : undefined;
  const asset = (e.detail.asset ?? app.ledger.state.withdrawals[String(e.detail.withdrawalId)]?.asset) as Asset | undefined;
  return { ...e, fromName: nameOf(e.account), toName: nameOf(e.detail.to), link: txHash && asset ? chainFor(asset).explorerTx(txHash) : undefined };
}

server.post<{ Body: { id: string; name: string } }>("/api/accounts", async (req) => {
  if (directory) throw new LedgerError("Sign in with Google: accounts are Turnkey wallets", "GOOGLE_ONLY");
  const { id, name } = req.body;
  if (!/^0x[0-9a-fA-F]{40}$/.test(id ?? "")) throw new LedgerError("id must be an address", "BAD_ID");
  if (!name?.trim()) throw new LedgerError("name required", "BAD_NAME");
  return app.signUp(id, name.trim().slice(0, 40));
});

/**
 * Continue with Google. Turnkey finds or creates the user's wallet and opens a session for the browser's own key.
 * The ledger account is the wallet's address, created here the first time, so sign-up costs no signature.
 */
server.post<{ Body: { oidcToken: string; publicKey: string } }>("/api/auth/google", async (req, reply) => {
  if (!directory) throw new LedgerError("Google sign-in is not turned on", "NO_GOOGLE");
  const { oidcToken, publicKey } = req.body ?? {};
  if (!oidcToken || !publicKey) throw new LedgerError("oidcToken and publicKey are required", "BAD_LOGIN");
  let s;
  try {
    s = await directory.signIn(oidcToken, publicKey);
  } catch (err) {
    reply.status(401);
    return { error: `Turnkey did not accept this Google sign-in: ${(err as Error).message}`, code: "LOGIN_REFUSED" };
  }
  if (s.created) app.log({ source: "turnkey", account: s.address, text: `Turnkey created your wallet: a sub-organization of your own (${s.organizationId}) whose only way in is your Google account. Address ${s.address}.`, ms: s.ms.create });
  app.log({ source: "turnkey", account: s.address, text: `Turnkey checked your Google sign-in and opened a session for this browser's key. Each request you make is signed by your wallet through that session.`, ms: s.ms.login });
  const existing = app.ledger.state.accounts[s.address];
  if (!existing) await app.signUp(s.address, s.name);
  return { organizationId: s.organizationId, address: s.address, name: existing?.name ?? s.name, session: s.session, expiresAt: s.expiresAt, created: s.created };
});

server.get<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
  const acct = app.ledger.getAccount(req.params.id);
  const withdrawals = Object.values(app.ledger.state.withdrawals)
    .filter((w) => w.account === acct.id)
    .slice(-20)
    .reverse()
    .map((w) => ({ ...w, link: w.txHash ? chainFor(w.asset).explorerTx(w.txHash) : undefined }));
  return { ...acct, events: app.ledger.eventsFor(acct.id).map(decorate), withdrawals, incoming: app.incomingFor(acct.id) };
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
