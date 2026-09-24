/**
 * The real vault: Turnkey holds every key.
 *
 * The vault is a Turnkey sub-organization whose only root user is the app's admin key. Inside it:
 *  - one HD wallet; each user's deposit address is one more account in it, valid on every EVM chain
 *  - a signer user (the app's signer key) with zero powers except its two policies:
 *      allow: sign Ethereum transactions from the vault wallet on Sepolia or Base Sepolia, up to the cap
 *      deny:  sign anything above the cap
 * The admin key sets this up and adds deposit addresses; the signer key signs withdrawals. The app never
 * sees a vault private key, and Turnkey checks the policies on every signature.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Turnkey, type TurnkeyApiClient } from "@turnkey/sdk-server";
import { getPublicKey } from "@turnkey/crypto";
import { bytesToHex, formatEther, getAddress, serializeTransaction, type Hex, type TransactionSerializable } from "viem";
import type { Vault } from "./index.js";

export const TURNKEY_API = process.env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com";
export const VAULT_WALLET_NAME = "Crossroads vault";
export const SIGNER_USER_NAME = "app-signer";
export const ADMIN_USER_NAME = "app-admin";

export interface ApiKeyPair {
  /** Compressed P-256 public key, hex without 0x: what Turnkey stores for an API key. */
  publicKey: string;
  privateKey: string;
}

export interface AppKeys {
  admin: ApiKeyPair;
  signer: ApiKeyPair;
}

/**
 * A Turnkey API key from 32 raw bytes. ROFL's key generation hands the app raw key material, so the
 * laptop path builds keys the same way from random bytes, and Phase 3 only changes where the bytes come from.
 */
export function apiKeyFromRaw(raw: Uint8Array): ApiKeyPair {
  if (raw.length !== 32) throw new Error("API key material must be 32 bytes");
  const privateKey = bytesToHex(raw).slice(2);
  const publicKey = bytesToHex(getPublicKey(raw, true)).slice(2); // throws if the bytes are not a valid P-256 key
  return { publicKey, privateKey };
}

/** The app's two Turnkey keys on a laptop: made once and kept beside the saved state, never in git. */
// NEXT PERSON: lose this file and the vault can never sign again; that is encumbrance working. A Claude workspace is
// wiped at session end, so a vault set up there is throwaway: never send it more than small test amounts.
export function loadOrCreateAppKeys(dir: string): AppKeys {
  const path = join(dir, "turnkey-app-keys.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as AppKeys;
  const keys: AppKeys = { admin: apiKeyFromRaw(randomBytes(32)), signer: apiKeyFromRaw(randomBytes(32)) };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  return keys;
}

/** The vault's sub-organization ID, written by the one-time setup. */
export function readVaultOrgId(dir: string): string | undefined {
  const path = join(dir, "turnkey-vault.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { organizationId: string }).organizationId : undefined;
}

export function writeVaultOrgId(dir: string, organizationId: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "turnkey-vault.json"), JSON.stringify({ organizationId }, null, 2) + "\n");
}

/** The vault sub-organization: its only root user is the app's admin key, and it has no email or phone anywhere. */
export function vaultSubOrgParams(parentOrgId: string, adminPublicKey: string) {
  return {
    organizationId: parentOrgId,
    subOrganizationName: `Crossroads vault ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    rootUsers: [{ userName: ADMIN_USER_NAME, apiKeys: [{ apiKeyName: "app-admin-key", publicKey: adminPublicKey, curveType: "API_KEY_CURVE_P256" as const }], authenticators: [], oauthProviders: [] }],
    rootQuorumThreshold: 1,
    // No email or phone anywhere in the vault, so there is nothing for parent-initiated recovery to use.
    disableEmailRecovery: true,
    disableEmailAuth: true,
    disableSmsAuth: true,
    disableOtpEmailAuth: true,
  };
}

/**
 * The vault's sub-organization ID: remembered beside STATE_PATH; after a move to a new machine, found again by asking
 * Turnkey which sub-organization the admin key belongs to; on the very first start, created by the app itself with its
 * sign-up key, so the vault's only root user is a key that was generated in the enclave and never left it.
 */
export async function findOrCreateVault(parentOrgId: string, keys: { admin: ApiKeyPair; signup: ApiKeyPair }, dir: string, log: (line: string) => void): Promise<string> {
  const known = readVaultOrgId(dir);
  if (known) return known;
  try {
    const me = await turnkeyClient(keys.admin, parentOrgId).getWhoami({ organizationId: parentOrgId });
    if (me.organizationId && me.organizationId !== parentOrgId) {
      writeVaultOrgId(dir, me.organizationId);
      log(`Found this app's existing Turnkey vault ${me.organizationId} by its admin key`);
      return me.organizationId;
    }
  } catch {
    // The admin key is not a user anywhere yet: first start.
  }
  const res = await turnkeyClient(keys.signup, parentOrgId).createSubOrganization(vaultSubOrgParams(parentOrgId, keys.admin.publicKey));
  writeVaultOrgId(dir, res.subOrganizationId);
  log(`Created the Turnkey vault ${res.subOrganizationId}; its only root user is this app's admin key`);
  return res.subOrganizationId;
}

export interface PolicySpec {
  policyName: string;
  effect: "EFFECT_ALLOW" | "EFFECT_DENY";
  consensus: string;
  condition: string;
  notes: string;
}

/** The signer's two policies. Turnkey denies anything no policy allows, and a deny beats any allow. */
export function signerPolicies(signerUserId: string, walletId: string, cap: bigint, chainIds: number[]): PolicySpec[] {
  const signer = `approvers.any(user, user.id == '${signerUserId}')`;
  const isTx = "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'";
  const chains = chainIds.map((id) => `eth.tx.chain_id == ${id}`).join(" || ");
  const capEth = formatEther(cap);
  return [
    {
      policyName: "Vault signer: withdrawals on Sepolia and Base Sepolia",
      effect: "EFFECT_ALLOW",
      consensus: signer,
      condition: `${isTx} && wallet.id == '${walletId}' && (${chains}) && eth.tx.value <= ${cap}`,
      notes: `The app's signer key may sign Ethereum transactions from the vault wallet on chains ${chainIds.join(", ")}, up to ${capEth} ETH each.`,
    },
    {
      policyName: `Vault signer: never more than ${capEth} ETH per withdrawal`,
      effect: "EFFECT_DENY",
      consensus: signer,
      condition: `${isTx} && eth.tx.value > ${cap}`,
      notes: "Circuit breaker: holds even if the app itself asks.",
    },
  ];
}

/** The Turnkey calls the vault uses; a narrow slice so tests can stand in for Turnkey. */
export type TurnkeyCalls = Pick<
  TurnkeyApiClient,
  "getWallets" | "createWallet" | "getWalletAccounts" | "createWalletAccounts" | "getUsers" | "createUsers" | "getPolicies" | "createPolicies" | "signTransaction"
>;

export interface TurnkeyVaultConfig {
  organizationId: string;
  keys: AppKeys;
  cap: bigint;
  chainIds: number[];
  /** Tests pass stand-ins; normally built from the keys. */
  clients?: { admin: TurnkeyCalls; signer: TurnkeyCalls };
}

export function turnkeyClient(key: ApiKeyPair, organizationId: string): TurnkeyApiClient {
  return new Turnkey({ apiBaseUrl: TURNKEY_API, apiPublicKey: key.publicKey, apiPrivateKey: key.privateKey, defaultOrganizationId: organizationId }).apiClient();
}

export class TurnkeyVault implements Vault {
  readonly label = "Turnkey";
  walletId = "";
  signerUserId = "";
  private admin: TurnkeyCalls;
  private signer: TurnkeyCalls;
  /** Deposit addresses are created one at a time so two sign-ups never claim the same wallet path. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly cfg: TurnkeyVaultConfig) {
    this.admin = cfg.clients?.admin ?? turnkeyClient(cfg.keys.admin, cfg.organizationId);
    this.signer = cfg.clients?.signer ?? turnkeyClient(cfg.keys.signer, cfg.organizationId);
  }

  /** Connect to the vault and make sure its wallet, signer user and policies exist (creates only what is missing). */
  static async open(cfg: TurnkeyVaultConfig, log: (line: string) => void = () => {}): Promise<TurnkeyVault> {
    const v = new TurnkeyVault(cfg);
    await v.bootstrap(log);
    return v;
  }

  private get org() {
    return { organizationId: this.cfg.organizationId };
  }

  private async bootstrap(log: (line: string) => void) {
    const { wallets } = await this.admin.getWallets(this.org);
    const existing = wallets.find((w) => w.walletName === VAULT_WALLET_NAME);
    if (existing) {
      this.walletId = existing.walletId;
    } else {
      this.walletId = (await this.admin.createWallet({ ...this.org, walletName: VAULT_WALLET_NAME, accounts: [] })).walletId;
      log(`Created the vault wallet (${this.walletId})`);
    }

    const { users } = await this.admin.getUsers(this.org);
    const signer = users.find((u) => u.userName === SIGNER_USER_NAME);
    if (signer) {
      this.signerUserId = signer.userId;
    } else {
      const res = await this.admin.createUsers({
        ...this.org,
        users: [{ userName: SIGNER_USER_NAME, apiKeys: [{ apiKeyName: "app-signer-key", publicKey: this.cfg.keys.signer.publicKey, curveType: "API_KEY_CURVE_P256" }], authenticators: [], oauthProviders: [], userTags: [] }],
      });
      this.signerUserId = res.userIds[0];
      log(`Created the signer user (${this.signerUserId}) with no powers except its policies`);
    }

    // NEXT PERSON: policies are matched by name only. Changing the cap or the chains leaves the old conditions in
    // Turnkey; to change them, set up a fresh vault (new STATE_PATH folder) rather than editing these strings.
    const { policies } = await this.admin.getPolicies(this.org);
    const have = new Set(policies.map((p) => p.policyName));
    const missing = signerPolicies(this.signerUserId, this.walletId, this.cfg.cap, this.cfg.chainIds).filter((p) => !have.has(p.policyName));
    if (missing.length) {
      await this.admin.createPolicies({ ...this.org, policies: missing });
      for (const p of missing) log(`Created policy: ${p.policyName}`);
    }
  }

  /** Every address in the vault wallet, lowercase. */
  async addresses(): Promise<string[]> {
    const { accounts } = await this.admin.getWalletAccounts({ ...this.org, walletId: this.walletId });
    return accounts.map((a) => a.address.toLowerCase());
  }

  newDepositAddress(): Promise<string> {
    const next = this.queue.then(async () => {
      const { accounts } = await this.admin.getWalletAccounts({ ...this.org, walletId: this.walletId });
      const used = accounts.map((a) => Number(a.path.split("/").pop()));
      const index = used.length ? Math.max(...used) + 1 : 0;
      const res = await this.admin.createWalletAccounts({
        ...this.org,
        walletId: this.walletId,
        accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: `m/44'/60'/0'/0/${index}`, addressFormat: "ADDRESS_FORMAT_ETHEREUM" }],
      });
      return res.addresses[0];
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async signTransaction(fromAddress: string, tx: TransactionSerializable): Promise<Hex> {
    const unsigned = serializeTransaction(tx);
    let signed: string;
    try {
      const res = await this.signer.signTransaction({
        ...this.org,
        signWith: getAddress(fromAddress), // the ledger keeps addresses lowercase; Turnkey matches the checksummed form
        unsignedTransaction: unsigned.slice(2),
        type: "TRANSACTION_TYPE_ETHEREUM",
      });
      signed = res.signedTransaction;
    } catch (err) {
      // Turnkey answers every policy refusal the same way ("insufficient permissions"); say which limit the request broke.
      if (!/sufficient permissions/i.test((err as Error).message)) throw err;
      const value = tx.value ?? 0n;
      const why =
        value > this.cfg.cap
          ? `${formatEther(value)} ETH is above the ${formatEther(this.cfg.cap)} ETH per-withdrawal cap`
          : tx.chainId !== undefined && !this.cfg.chainIds.includes(tx.chainId)
            ? `chain ${tx.chainId} is not one the vault may sign for`
            : "no policy allows this signature";
      throw new Error(`Policy refused: ${why}`);
    }
    return (signed.startsWith("0x") ? signed : `0x${signed}`) as Hex;
  }

  describe() {
    return `Turnkey vault (sub-organization ${this.cfg.organizationId}). Keys stay in Turnkey; the app's signer key can sign only under its policies.`;
  }
}
