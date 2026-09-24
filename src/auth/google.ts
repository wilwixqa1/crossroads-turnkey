/**
 * Google sign-in through Turnkey (Phase 2b).
 *
 * The browser makes its own session key, asks Google for a sign-in token bound to that key (the token's nonce is
 * sha256 of the key's hex text), and sends the token and the public key here. The app, using its own sign-up key
 * in Will's organization (limited by policy to creating sub-organizations and starting logins):
 *   1. finds the user's Turnkey sub-organization by the Google token, or creates one with one Ethereum wallet;
 *   2. asks Turnkey to open a session for the browser's key. Turnkey checks the token and that the nonce matches.
 * From then on the browser signs with the user's wallet by talking to Turnkey directly. The app never holds a user key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { TurnkeyApiClient } from "@turnkey/sdk-server";
import { activityIdOf, apiKeyFromRaw, turnkeyClient, type ApiKeyPair, type PolicySpec } from "../signer/turnkey.js";

export const SIGNUP_USER_NAME = "crossroads-signup";
export const USER_WALLET_NAME = "Crossroads wallet";
/** How long a sign-in lasts before the page asks for Google again. Long enough for a rehearsal plus the call. */
export const SESSION_SECONDS = Number(process.env.SESSION_SECONDS ?? 8 * 60 * 60);

export type SignupCalls = Pick<TurnkeyApiClient, "getSubOrgIds" | "createSubOrganization" | "oauthLogin" | "getWallets" | "getWalletAccounts">;

export interface GoogleSignIn {
  /** The user's own Turnkey sub-organization. */
  organizationId: string;
  /** Their wallet's Ethereum address: their account ID on the ledger. */
  address: string;
  name: string;
  /** Turnkey's session token for the browser's key. The key itself never leaves the browser. */
  session: string;
  expiresAt: number;
  created: boolean;
  ms: { lookup: number; create?: number; login: number };
  /** Turnkey activity IDs: the wallet's creation (first sign-in only) and the session's opening. */
  activities: { create?: string; login?: string };
}

/** The display claims of a Google token. Only read after Turnkey has accepted the token, and only for names on screen. */
export function tokenClaims(oidcToken: string): { sub?: string; name?: string; email?: string; nonce?: string } {
  try {
    return JSON.parse(Buffer.from(oidcToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

/** The one policy the sign-up key gets in Will's organization: create sub-organizations and start logins, nothing else. */
export function signupPolicy(signupUserId: string): PolicySpec {
  return {
    policyName: "Crossroads sign-up: create user wallets and start Google logins only",
    effect: "EFFECT_ALLOW",
    consensus: `approvers.any(user, user.id == '${signupUserId}')`,
    condition: "(activity.resource == 'ORGANIZATION' && activity.action == 'CREATE') || (activity.resource == 'AUTH' && activity.action == 'CREATE')",
    notes: "Lets the Crossroads app create each user's wallet (a sub-organization) and open a session after Google sign-in. It cannot sign, export, or change anything.",
  };
}

export class UserDirectory {
  constructor(
    private readonly parentOrgId: string,
    private readonly client: SignupCalls,
  ) {}

  static open(parentOrgId: string, key: ApiKeyPair): UserDirectory {
    return new UserDirectory(parentOrgId, turnkeyClient(key, parentOrgId));
  }

  async signIn(oidcToken: string, publicKey: string): Promise<GoogleSignIn> {
    if (!/^0[23][0-9a-f]{64}$/i.test(publicKey)) throw new Error("The browser's session key is not a compressed P-256 public key");
    const claims = tokenClaims(oidcToken);
    const name = (claims.name ?? claims.email?.split("@")[0] ?? "Crossroads user").slice(0, 40);

    let t0 = Date.now();
    const { organizationIds } = await this.client.getSubOrgIds({ organizationId: this.parentOrgId, filterType: "OIDC_TOKEN", filterValue: oidcToken });
    const ms: GoogleSignIn["ms"] = { lookup: Date.now() - t0, login: 0 };

    let organizationId = organizationIds?.[0];
    let address: string | undefined;
    let created = false;
    const activities: GoogleSignIn["activities"] = {};
    if (!organizationId) {
      t0 = Date.now();
      // NEXT PERSON: no email, phone, or email recovery on user wallets. The only way in is this Google account, so
      // Will's organization cannot start a login or recovery for the user by any other route.
      const res = await this.client.createSubOrganization({
        organizationId: this.parentOrgId,
        subOrganizationName: `Crossroads user: ${name}`,
        rootUsers: [{ userName: name, apiKeys: [], authenticators: [], oauthProviders: [{ providerName: "Google", oidcToken }] }],
        rootQuorumThreshold: 1,
        disableEmailRecovery: true,
        disableEmailAuth: true,
        disableSmsAuth: true,
        disableOtpEmailAuth: true,
        wallet: {
          walletName: USER_WALLET_NAME,
          accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }],
        },
      });
      ms.create = Date.now() - t0;
      activities.create = activityIdOf(res);
      organizationId = res.subOrganizationId;
      address = res.wallet?.addresses?.[0];
      created = true;
    }
    if (!organizationId) throw new Error("Turnkey did not return the user's sub-organization");
    address ??= await this.walletAddress(organizationId);

    t0 = Date.now();
    const login = await this.client.oauthLogin({ organizationId, oidcToken, publicKey, expirationSeconds: String(SESSION_SECONDS) });
    const { session } = login;
    activities.login = activityIdOf(login);
    ms.login = Date.now() - t0;
    if (!session) throw new Error("Turnkey did not open a session");

    return { organizationId, address: address.toLowerCase(), name, session, expiresAt: Date.now() + SESSION_SECONDS * 1000, created, ms, activities };
  }

  /** The user's wallet address, read with the parent's read-only access to the sub-organization. */
  private async walletAddress(organizationId: string): Promise<string> {
    const { wallets } = await this.client.getWallets({ organizationId });
    const wallet = wallets.find((w) => w.walletName === USER_WALLET_NAME) ?? wallets[0];
    if (!wallet) throw new Error("The user's Turnkey sub-organization has no wallet");
    const { accounts } = await this.client.getWalletAccounts({ organizationId, walletId: wallet.walletId });
    const eth = accounts.find((a) => a.addressFormat === "ADDRESS_FORMAT_ETHEREUM");
    if (!eth) throw new Error("The user's Turnkey wallet has no Ethereum address");
    return eth.address;
  }
}

/** The app's sign-up key on a laptop: made once and kept beside the saved state. In ROFL it comes from the enclave. */
export function loadOrCreateSignupKey(dir: string): ApiKeyPair {
  const path = join(dir, "turnkey-signup-key.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as ApiKeyPair;
  const key = apiKeyFromRaw(randomBytes(32));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(key, null, 2) + "\n", { mode: 0o600 });
  return key;
}
