/**
 * The proof page: everything on it is read live, and every live check asks for something forbidden.
 *
 * Live checks never use the vault admin key: it is the vault's root user, so anything it asked for would succeed.
 * Each check is expected to be refused. Refusals cost nothing on Turnkey's meter; if a check were ever NOT refused,
 * the page says so plainly, and nothing it produced is ever broadcast.
 */
import { encodeFunctionData, parseEther, type Hex, type TransactionSerializable } from "viem";
import type { App } from "./app.js";
import { CHAINS } from "./chains/config.js";
import { AAVE_MARKETS, POOL_ABI } from "./chains/aave.js";
import { LedgerError } from "./ledger/ledger.js";
import { VaultError, type VaultNote } from "./signer/index.js";
import { TurnkeyVault } from "./signer/turnkey.js";
import type { UserDirectory } from "./auth/google.js";

export type CheckId = "export" | "network" | "borrow" | "signup" | "replay";

export interface CheckResult {
  id: CheckId;
  /** refused: what the demo expects. allowed: the forbidden thing happened (never expected). error: the check could not run. */
  outcome: "refused" | "allowed" | "error";
  /** Who refused: Turnkey, or Crossroads' own ledger. */
  by?: "Turnkey" | "Crossroads" | "Stand-in vault";
  /** Which key made the attempt. */
  key: "vault signer" | "sign-up key" | "a copied request";
  message: string;
  activityId?: string;
  /** Where the activity lives: the vault's Activities, or Will's own organization's. */
  where?: "vault" | "your organization";
  policy?: string;
  ms: number;
}

export const CHECKS: { id: CheckId; title: string; what: string }[] = [
  { id: "export", title: "Export the vault wallet", what: "The vault's signer key asks Turnkey to export the vault wallet's keys." },
  { id: "network", title: "Sign on a network the vault may not use", what: "The vault's signer key asks Turnkey to sign 0.001 ETH on Ethereum mainnet." },
  { id: "borrow", title: "Borrow against the vault on Aave", what: "The vault's signer key asks Turnkey to sign an Aave borrow of 0.01 WETH against the vault's own supply." },
  { id: "signup", title: "Sign-up key reaches beyond sign-up", what: "The app's sign-up key tries to add a policy to Will's Turnkey organization." },
  { id: "replay", title: "Replay a request someone already used", what: "The most recent signed request anyone made is sent to Crossroads a second time." },
];

/** A transaction number no vault address will ever reach, so even an unexpected signature could never land on-chain. */
const NEVER_NONCE = 999_999_999;

function probeTx(chainId: number, to: Hex, value: bigint, data?: Hex, gas = 21_000n): TransactionSerializable {
  return { chainId, type: "eip1559", to, value, data, nonce: NEVER_NONCE, gas, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n };
}

let running = false;

export async function runCheck(id: CheckId, app: App, directory?: UserDirectory): Promise<CheckResult> {
  if (running) throw new LedgerError("Another check is running. Try again in a moment.", "BUSY");
  running = true;
  const t0 = Date.now();
  const done = (r: Omit<CheckResult, "id" | "ms">): CheckResult => ({ id, ms: Date.now() - t0, ...r });
  try {
    const vault = app.vault;
    const label = vault instanceof TurnkeyVault ? "Turnkey" : "Stand-in vault";
    const from = app.ledger.depositAddresses()[0];
    const signCheck = async (tx: TransactionSerializable): Promise<CheckResult> => {
      if (!from) return done({ outcome: "error", key: "vault signer", message: "The vault has no address yet. Sign in once first." });
      const note: VaultNote = {};
      try {
        await vault.signTransaction(from, tx, note);
        return done({ outcome: "allowed", key: "vault signer", by: label, message: `${label} signed it. This should never happen. Nothing was broadcast, and its transaction number can never be used.`, activityId: note.activityId, where: "vault", policy: note.policy });
      } catch (err) {
        if (err instanceof VaultError) return done({ outcome: "refused", key: "vault signer", by: label, message: err.message, activityId: err.note.activityId, where: "vault", policy: err.note.policy });
        return done({ outcome: "error", key: "vault signer", message: (err as Error).message.slice(0, 200) });
      }
    };
    switch (id) {
      case "export": {
        if (!(vault instanceof TurnkeyVault)) return done({ outcome: "error", key: "vault signer", message: "The stand-in vault keeps its keys in this process; this check only means something with Turnkey." });
        try {
          const r = await vault.tryExport();
          return done({ outcome: r.refused ? "refused" : "allowed", key: "vault signer", by: "Turnkey", message: r.message, activityId: r.activityId, where: "vault", policy: r.policy });
        } catch (err) {
          return done({ outcome: "error", key: "vault signer", message: (err as Error).message.slice(0, 200) });
        }
      }
      case "network":
        return await signCheck(probeTx(1, (from ?? "0x0000000000000000000000000000000000000001") as Hex, parseEther("0.001")));
      case "borrow": {
        const m = AAVE_MARKETS[0];
        const data = encodeFunctionData({ abi: POOL_ABI, functionName: "borrow", args: [m.weth, parseEther("0.01"), 2n, 0, (from ?? m.pool) as Hex] });
        return await signCheck(probeTx(m.chainId, m.pool, 0n, data, 400_000n));
      }
      case "signup": {
        if (!directory) return done({ outcome: "error", key: "sign-up key", message: "Google sign-in is off here, so there is no sign-up key to test." });
        try {
          const r = await directory.tryAddPolicy();
          return done({ outcome: r.refused ? "refused" : "allowed", key: "sign-up key", by: "Turnkey", message: r.message, activityId: r.activityId, where: "your organization", policy: r.policy });
        } catch (err) {
          return done({ outcome: "error", key: "sign-up key", message: (err as Error).message.slice(0, 200) });
        }
      }
      case "replay": {
        const last = app.lastRequest;
        if (!last) return done({ outcome: "error", key: "a copied request", message: "No one has made a request since the app started. Make any trade, send or withdrawal first." });
        try {
          await app.handleRequest(last);
          return done({ outcome: "allowed", key: "a copied request", by: "Crossroads", message: "Crossroads accepted the same request twice. This should never happen." });
        } catch (err) {
          const code = (err as LedgerError).code;
          if (code === "BAD_SEQ") return done({ outcome: "refused", key: "a copied request", by: "Crossroads", message: `${(err as Error).message}. Request #${last.seq} from ${app.ledger.state.accounts[last.account.toLowerCase()]?.name ?? "that account"} was already used, so its signature is worthless now.` });
          return done({ outcome: "error", key: "a copied request", message: (err as Error).message.slice(0, 200) });
        }
      }
    }
  } finally {
    running = false;
  }
}

// ---------- code version ----------

const REPO_RAW = "https://raw.githubusercontent.com/wilwixqa1/crossroads-turnkey/main";
let manifest: { at: number; value: Awaited<ReturnType<typeof readManifest>> } | undefined;

/** The version registered for this app, from the manifest the deploy workflow commits after every deploy. */
async function readManifest() {
  const get = async (f: string) => {
    const res = await fetch(`${REPO_RAW}/${f}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`${f}: ${res.status}`);
    return res.text();
  };
  const [rofl, compose] = await Promise.all([get("rofl.yaml"), get("compose.yaml")]);
  return {
    enclaveIds: [...rofl.matchAll(/- id: (\S+)/g)].map((m) => m[1]),
    image: /image: "?([^"\s]+)"?/.exec(compose)?.[1] ?? null,
    appId: /app_id: (\S+)/.exec(rofl)?.[1] ?? null,
    manifestLink: "https://github.com/wilwixqa1/crossroads-turnkey/blob/main/rofl.yaml",
    composeLink: "https://github.com/wilwixqa1/crossroads-turnkey/blob/main/compose.yaml",
  };
}

export async function codeVersion(roflAppId: string | undefined) {
  let committed = null;
  try {
    if (!manifest || Date.now() - manifest.at > 5 * 60_000) manifest = { at: Date.now(), value: await readManifest() };
    committed = manifest.value;
  } catch {
    /* GitHub unreachable: show what the enclave itself reports */
  }
  return {
    roflAppId: roflAppId ?? null,
    explorer: roflAppId ? `https://explorer.oasis.io/testnet/sapphire/rofl/app/${roflAppId}` : null,
    committed,
  };
}

/** Explorer link for a vault signature's transaction, by chain. */
export function explorerFor(chainId: number | undefined, txHash: string | undefined): string | undefined {
  if (!chainId || !txHash) return undefined;
  return CHAINS.find((c) => c.chain.id === chainId)?.explorerTx(txHash);
}
