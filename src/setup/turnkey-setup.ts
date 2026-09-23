/**
 * One-time vault setup, run with Will's parent-organization key (the only place that key is used).
 *
 *   1. Create the vault sub-organization with the app's admin key as its only root user.
 *   2. As the app's admin: create the vault wallet, the signer user, and the signer's two policies.
 *
 * Settings: TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY (Will's parent org and key),
 * STATE_PATH (the app's keys and the vault ID are kept beside it). Safe to re-run: it creates only what is missing.
 */
import { dirname, join } from "node:path";
import { WITHDRAWAL_CAP } from "../app.js";
import { CHAINS } from "../chains/config.js";
import { ADMIN_USER_NAME, TurnkeyVault, loadOrCreateAppKeys, readVaultOrgId, turnkeyClient, writeVaultOrgId } from "../signer/turnkey.js";

const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const dir = dirname(process.env.STATE_PATH ?? join(process.cwd(), "data", "state.json"));
const parentOrg = need("TURNKEY_ORG_ID");
const parent = turnkeyClient({ publicKey: need("TURNKEY_API_PUBLIC_KEY"), privateKey: need("TURNKEY_API_PRIVATE_KEY") }, parentOrg);
const keys = loadOrCreateAppKeys(dir);

let organizationId = readVaultOrgId(dir);
if (organizationId) {
  console.log(`Vault sub-organization already exists: ${organizationId}`);
} else {
  const res = await parent.createSubOrganization({
    organizationId: parentOrg,
    subOrganizationName: `Crossroads vault ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    rootUsers: [{ userName: ADMIN_USER_NAME, apiKeys: [{ apiKeyName: "app-admin-key", publicKey: keys.admin.publicKey, curveType: "API_KEY_CURVE_P256" }], authenticators: [], oauthProviders: [] }],
    rootQuorumThreshold: 1,
    // No email or phone anywhere in the vault, so there is nothing for parent-initiated recovery to use.
    disableEmailRecovery: true,
    disableEmailAuth: true,
    disableSmsAuth: true,
    disableOtpEmailAuth: true,
  });
  organizationId = res.subOrganizationId;
  writeVaultOrgId(dir, organizationId);
  console.log(`Created the vault sub-organization ${organizationId}; its only root user is the app's admin key`);
}

const vault = await TurnkeyVault.open(
  { organizationId, keys, cap: WITHDRAWAL_CAP, chainIds: CHAINS.map((c) => c.chain.id) },
  (line) => console.log(line),
);
console.log(`\nVault ready.\n  Sub-organization: ${organizationId}\n  Wallet: ${vault.walletId}\n  Signer user: ${vault.signerUserId}\n  App admin public key: ${keys.admin.publicKey}\n  App signer public key: ${keys.signer.publicKey}`);
