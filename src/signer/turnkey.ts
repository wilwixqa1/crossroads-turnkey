/**
 * The real vault: Turnkey holds every key.
 *
 * The vault is a Turnkey sub-organization whose only root user is the app's admin key. Inside it:
 *  - one HD wallet; each user's deposit address is one more account in it, valid on every EVM chain
 *  - a signer user (the app's signer key) with zero powers except its policies (see ./policy.ts):
 *      plain ETH transfers up to each network's limit, Aave supply and withdraw for the vault itself, never borrow
 * The admin key sets this up and adds deposit addresses; the signer key signs withdrawals. The app never
 * sees a vault private key, and Turnkey checks the policies on every signature.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFileDurably } from "../storage/state.js";
import { join } from "node:path";
import { Turnkey, type TurnkeyApiClient } from "@turnkey/sdk-server";
import { generateP256KeyPair, getPublicKey } from "@turnkey/crypto";
import { bytesToHex, getAddress, keccak256, parseTransaction, serializeTransaction, type Hex, type TransactionSerializable } from "viem";
import { VaultError, type Vault, type VaultNote } from "./index.js";
import { SIGNER_PREFIX, contractInterfaces, evaluate, signerPolicies, turnkeyAbi, type ChainLimit, type PolicySpec } from "./policy.js";
import type { AaveMarket } from "../chains/aave.js";

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
  writeFileDurably(join(dir, "turnkey-vault.json"), JSON.stringify({ organizationId }, null, 2) + "\n");
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

/** The Turnkey activity ID the SDK attaches to every completed call. */
export function activityIdOf(res: unknown): string | undefined {
  return (res as { activity?: { id?: string } })?.activity?.id;
}

export type { PolicySpec } from "./policy.js";

/** The Turnkey calls the vault uses; a narrow slice so tests can stand in for Turnkey. */
export type TurnkeyCalls = Pick<
  TurnkeyApiClient,
  | "getWallets"
  | "createWallet"
  | "getWalletAccounts"
  | "createWalletAccounts"
  | "getUsers"
  | "createUsers"
  | "getPolicies"
  | "createPolicies"
  | "deletePolicy"
  | "getSmartContractInterfaces"
  | "createSmartContractInterface"
  | "signTransaction"
  | "getActivities"
  | "getPolicyEvaluations"
  | "getOrganizationConfigs"
  | "exportWallet"
>;

export interface TurnkeyVaultConfig {
  organizationId: string;
  keys: AppKeys;
  /** One withdrawal limit per network; each becomes an allow and a deny policy. */
  limits: ChainLimit[];
  /** Aave markets the vault may supply to (never borrow from). */
  aave?: AaveMarket[];
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

    // NEXT PERSON: a failed rules update must not stop the vault from opening: the old policies stay in force (new ones
    // are created before old ones are deleted), the page shows the problem, and withdrawals keep working.
    try {
      await this.syncContractInterfaces(log);
      await this.syncPolicies(log);
      this.policyProblem = undefined;
    } catch (err) {
      this.policyProblem = `Could not update the vault's policies: ${(err as Error).message.split("\n")[0].slice(0, 300)}`;
      log(this.policyProblem);
    }
  }

  /** Set when the last policy update failed; the vault then runs on the policies it already had. */
  policyProblem?: string;

  /** Upload the Aave contracts' interfaces once, so Turnkey can decode those calls for the policies. */
  private async syncContractInterfaces(log: (line: string) => void) {
    const wanted = contractInterfaces(this.cfg.aave ?? []);
    if (!wanted.length) return;
    const { smartContractInterfaces } = await this.admin.getSmartContractInterfaces(this.org);
    const have = new Set(smartContractInterfaces.map((i) => i.smartContractAddress.toLowerCase()));
    for (const w of wanted.filter((w) => !have.has(w.address.toLowerCase()))) {
      await this.admin.createSmartContractInterface({
        ...this.org,
        label: w.label,
        notes: "Uploaded by the Crossroads app so the vault signer's policies can read these calls.",
        type: "SMART_CONTRACT_INTERFACE_TYPE_ETHEREUM",
        smartContractAddress: w.address,
        smartContractInterface: turnkeyAbi(w.abi),
      });
      log(`Uploaded the contract interface for ${w.label}`);
    }
  }

  /**
   * Make the signer's policies exactly the ones signerPolicies() describes: create what is missing first, then delete
   * the signer policies that no longer match (an older limit, older wording). Creating first means a failed create
   * leaves the old rules in force rather than none. Turnkey requires unique policy names, so a rule whose wording
   * changed under the same name is deleted just before its replacement is created (before the app serves anything).
   */
  private async syncPolicies(log: (line: string) => void) {
    const desired = signerPolicies(this.signerUserId, this.walletId, this.cfg.limits, this.cfg.aave ?? []);
    const { policies } = await this.admin.getPolicies(this.org);
    const squash = (x: string) => x.replace(/\s+/g, "");
    const same = (p: { policyName: string; effect: string; condition?: string; consensus?: string }, d: PolicySpec) =>
      p.policyName === d.policyName && p.effect === d.effect && squash(p.condition ?? "") === squash(d.condition) && squash(p.consensus ?? "") === squash(d.consensus);
    const signers = policies.filter((p) => p.policyName.startsWith(SIGNER_PREFIX) || (p.consensus ?? "").includes(this.signerUserId));
    const missing = desired.filter((d) => !signers.some((p) => same(p, d)));
    let stale = signers.filter((p) => !desired.some((d) => same(p, d)));
    const renamed = stale.filter((p) => missing.some((d) => d.policyName === p.policyName));
    const fresh = missing.filter((d) => !renamed.some((p) => p.policyName === d.policyName));
    if (fresh.length) {
      await this.admin.createPolicies({ ...this.org, policies: fresh });
      for (const p of fresh) log(`Created policy: ${p.policyName}`);
    }
    for (const old of renamed) {
      await this.admin.deletePolicy({ ...this.org, policyId: old.policyId });
      await this.admin.createPolicies({ ...this.org, policies: missing.filter((d) => d.policyName === old.policyName) });
      log(`Updated policy: ${old.policyName}`);
    }
    stale = stale.filter((p) => !renamed.includes(p));
    for (const p of stale) {
      await this.admin.deletePolicy({ ...this.org, policyId: p.policyId });
      log(`Removed old policy: ${p.policyName}`);
    }
    this.policyNames.clear();
  }

  /** Policy names by ID, for naming the policy that decided a signature. Refreshed when an unknown ID shows up. */
  private policyNames = new Map<string, string>();

  private async policyName(id: string): Promise<string | undefined> {
    if (!this.policyNames.has(id)) {
      const { policies } = await this.admin.getPolicies(this.org);
      for (const p of policies) this.policyNames.set(p.policyId, p.policyName);
    }
    return this.policyNames.get(id);
  }

  /**
   * Turnkey's own record of which policies decided an activity, by name. The deciding one comes first: the explicit
   * deny for a refusal, the allow for a signature.
   */
  async policyOutcomes(activityId: string): Promise<{ name: string; outcome: string }[]> {
    const { policyEvaluations } = await this.admin.getPolicyEvaluations({ ...this.org, activityId });
    const out: { name: string; outcome: string }[] = [];
    for (const e of policyEvaluations ?? []) {
      for (const p of e.policyEvaluations ?? []) {
        if (!p.policyId || !p.outcome) continue;
        out.push({ name: (await this.policyName(p.policyId)) ?? p.policyId, outcome: p.outcome });
      }
    }
    const rank = (o: string) => (o === "OUTCOME_DENY_EXPLICIT" ? 0 : o === "OUTCOME_ALLOW" ? 1 : 2);
    return out.sort((a, b) => rank(a.outcome) - rank(b.outcome));
  }

  /** The policy Turnkey says decided this activity, or undefined if it cannot say (display only). */
  private async decidingPolicy(activityId: string | undefined, allowed: boolean): Promise<string | undefined> {
    if (!activityId) return undefined;
    try {
      const want = allowed ? "OUTCOME_ALLOW" : "OUTCOME_DENY_EXPLICIT";
      return (await this.policyOutcomes(activityId)).find((o) => o.outcome === want)?.name;
    } catch {
      return undefined;
    }
  }

  /** The newest refused signature in the vault, so the page can name the exact activity Turnkey rejected. */
  private lastRejectedSignature(): Promise<string | undefined> {
    return this.lastRejected("ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
  }

  // NEXT PERSON: this is "the newest rejected activity of this type", not a lookup by request. Two refusals at the same
  // moment could swap IDs on the page (display only).
  private async lastRejected(type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" | "ACTIVITY_TYPE_EXPORT_WALLET"): Promise<string | undefined> {
    try {
      const { activities } = await this.admin.getActivities({ ...this.org, filterByType: [type], filterByStatus: ["ACTIVITY_STATUS_REJECTED"], paginationOptions: { limit: "1" } });
      return activities[0]?.id;
    } catch {
      return undefined; // display only
    }
  }

  // ---------- proof page (read-only, plus refusals by the signer; never anything with the admin key) ----------

  /** Who can act in the vault, read live from Turnkey: its users, its root quorum, the signer's policies. */
  async keyControl() {
    const [{ users }, { policies }, { configs }, { smartContractInterfaces }] = await Promise.all([
      this.admin.getUsers(this.org),
      this.admin.getPolicies(this.org),
      this.admin.getOrganizationConfigs(this.org),
      this.admin.getSmartContractInterfaces(this.org),
    ]);
    const quorum = configs.quorum;
    const keyOf = (pk: string) => (pk === this.cfg.keys.admin.publicKey ? "the app's admin key" : pk === this.cfg.keys.signer.publicKey ? "the app's signer key" : "a key this app does not know");
    return {
      organizationId: this.cfg.organizationId,
      users: users.map((u) => ({
        name: u.userName,
        id: u.userId,
        root: quorum?.userIds.includes(u.userId) ?? false,
        credentials: [
          ...u.apiKeys.map((k) => `API key ${k.credential.publicKey.slice(0, 10)}… (${keyOf(k.credential.publicKey)})`),
          ...u.authenticators.map(() => "passkey"),
          ...u.oauthProviders.map((o) => `${o.providerName} sign-in`),
        ],
        email: !!u.userEmail,
        phone: !!u.userPhoneNumber,
      })),
      rootQuorum: { threshold: quorum?.threshold ?? 0, members: (quorum?.userIds ?? []).map((id) => users.find((u) => u.userId === id)?.userName ?? id) },
      policies: policies.map((p) => ({ name: p.policyName, effect: p.effect, condition: p.condition ?? "", notes: p.notes ?? "" })),
      contractInterfaces: smartContractInterfaces.map((i) => ({ label: i.label, address: i.smartContractAddress })),
    };
  }

  /** The vault's recent signing activity, with the on-chain transaction each signature became. */
  async signingHistory(limit = 12) {
    const { activities } = await this.admin.getActivities({ ...this.org, filterByType: ["ACTIVITY_TYPE_SIGN_TRANSACTION_V2"], paginationOptions: { limit: String(limit) } });
    return activities.map((a) => {
      const unsigned = a.intent?.signTransactionIntentV2?.unsignedTransaction;
      const signed = a.result?.signTransactionResult?.signedTransaction;
      let chainId: number | undefined;
      let to: string | undefined;
      let value: string | undefined;
      try {
        const tx = parseTransaction(`0x${(unsigned ?? "").replace(/^0x/, "")}` as Hex);
        chainId = tx.chainId;
        to = tx.to ?? undefined;
        value = (tx.value ?? 0n).toString();
      } catch {
        /* not an Ethereum transaction we can read */
      }
      return {
        id: a.id,
        status: a.status,
        at: Number(a.createdAt?.seconds ?? 0) * 1000,
        chainId,
        to,
        value,
        txHash: signed ? keccak256(`0x${signed.replace(/^0x/, "")}` as Hex) : undefined,
      };
    });
  }

  /** The signer asks Turnkey to export the vault wallet, to a key that is thrown away at once. Turnkey must refuse. */
  async tryExport(): Promise<{ refused: boolean; message: string; activityId?: string; policy?: string }> {
    const target = generateP256KeyPair().publicKeyUncompressed; // its private half is never kept
    try {
      await this.signer.exportWallet({ ...this.org, walletId: this.walletId, targetPublicKey: target });
      return { refused: false, message: "Turnkey exported the wallet, encrypted to a key nobody kept. This should never happen." };
    } catch (err) {
      if (!/sufficient permissions/i.test((err as Error).message)) throw err; // not a refusal: the check did not run
      const activityId = await this.lastRejected("ACTIVITY_TYPE_EXPORT_WALLET");
      return { refused: true, message: (err as Error).message.split("\n")[0].slice(0, 200), activityId, policy: "No policy allows it" };
    }
  }

  /** Every address in the vault wallet, lowercase. */
  async addresses(): Promise<string[]> {
    const { accounts } = await this.admin.getWalletAccounts({ ...this.org, walletId: this.walletId });
    return accounts.map((a) => a.address.toLowerCase());
  }

  async holds(address: string): Promise<boolean> {
    return (await this.addresses()).includes(address.toLowerCase());
  }

  newDepositAddress(note?: VaultNote): Promise<string> {
    const next = this.queue.then(async () => {
      const { accounts } = await this.admin.getWalletAccounts({ ...this.org, walletId: this.walletId });
      const used = accounts.map((a) => Number(a.path.split("/").pop()));
      const index = used.length ? Math.max(...used) + 1 : 0;
      const res = await this.admin.createWalletAccounts({
        ...this.org,
        walletId: this.walletId,
        accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: `m/44'/60'/0'/0/${index}`, addressFormat: "ADDRESS_FORMAT_ETHEREUM" }],
      });
      if (note) note.activityId = activityIdOf(res);
      return res.addresses[0];
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async signTransaction(fromAddress: string, tx: TransactionSerializable, note?: VaultNote): Promise<Hex> {
    const unsigned = serializeTransaction(tx);
    // What the rules say, in words. Turnkey decides; this only explains its decision on the page.
    const expected = evaluate(tx, fromAddress, this.cfg.limits, this.cfg.aave ?? []);
    let signed: string;
    try {
      const res = await this.signer.signTransaction({
        ...this.org,
        signWith: getAddress(fromAddress), // the ledger keeps addresses lowercase; Turnkey matches the checksummed form
        unsignedTransaction: unsigned.slice(2),
        type: "TRANSACTION_TYPE_ETHEREUM",
      });
      signed = res.signedTransaction;
      if (note) {
        note.activityId = activityIdOf(res);
        const by = (await this.decidingPolicy(note.activityId, true)) ?? expected.policy;
        note.policy = by ? `Allowed by "${by}" (${expected.allowed ? expected.reason : "Turnkey's decision"})` : undefined;
        note.call = expected.call;
      }
    } catch (err) {
      // Turnkey answers every policy refusal the same way ("insufficient permissions"); name the rule that refused it.
      if (!/sufficient permissions/i.test((err as Error).message)) throw err;
      const activityId = await this.lastRejectedSignature();
      const by = (await this.decidingPolicy(activityId, false)) ?? (expected.allowed ? undefined : expected.policy);
      throw new VaultError(`Policy refused: ${expected.allowed ? "no policy allows this signature" : expected.reason}`, {
        activityId,
        policy: by ? `Denied by "${by}"` : `No policy allows it`,
        call: expected.call,
      });
    }
    return (signed.startsWith("0x") ? signed : `0x${signed}`) as Hex;
  }

  describe() {
    return `Turnkey vault (sub-organization ${this.cfg.organizationId}). Keys stay in Turnkey; the app's signer key can sign only under its policies.`;
  }
}
