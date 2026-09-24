/**
 * One-time Google sign-in setup, run with Will's parent-organization key (like the vault setup, the only place
 * that key is used).
 *
 * Adds one ordinary user to Will's organization, "crossroads-signup", holding the app's sign-up public key, and
 * one policy that lets that user do exactly two things: create user wallets (sub-organizations) and start logins.
 *
 * Settings: TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY (Will's parent org and key).
 * SIGNUP_PUBLIC_KEY: the sign-up key the running app shows on /api/status. Unset: the key kept beside STATE_PATH
 * (laptop). Safe to re-run: it creates only what is missing. If the app's key changed (a new deployment), it adds
 * the new key and removes every other key from the sign-up user, so only the running app holds this permission.
 * KEEP_OTHER_KEYS=1 skips the removal (for a temporary test key beside the live one).
 */
import { dirname, join } from "node:path";
import { SIGNUP_USER_NAME, loadOrCreateSignupKey, signupPolicy } from "../auth/google.js";
import { turnkeyClient } from "../signer/turnkey.js";

const need = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const parentOrg = need("TURNKEY_ORG_ID");
const parent = turnkeyClient({ publicKey: need("TURNKEY_API_PUBLIC_KEY"), privateKey: need("TURNKEY_API_PRIVATE_KEY") }, parentOrg);
const publicKey = process.env.SIGNUP_PUBLIC_KEY?.trim() || loadOrCreateSignupKey(dirname(process.env.STATE_PATH ?? join(process.cwd(), "data", "state.json"))).publicKey;
if (!/^0[23][0-9a-f]{64}$/i.test(publicKey)) throw new Error("SIGNUP_PUBLIC_KEY is not a compressed P-256 public key");
const org = { organizationId: parentOrg };

const { users } = await parent.getUsers(org);
let user = users.find((u) => u.userName === SIGNUP_USER_NAME);
if (!user) {
  const res = await parent.createUsers({
    ...org,
    users: [{ userName: SIGNUP_USER_NAME, apiKeys: [{ apiKeyName: `signup-${publicKey.slice(0, 10)}`, publicKey, curveType: "API_KEY_CURVE_P256" }], authenticators: [], oauthProviders: [], userTags: [] }],
  });
  console.log(`Created user ${SIGNUP_USER_NAME} (${res.userIds[0]}) with the app's sign-up key`);
  user = (await parent.getUsers(org)).users.find((u) => u.userName === SIGNUP_USER_NAME);
} else if (!user.apiKeys.some((k) => k.credential.publicKey === publicKey)) {
  // A new deployment made a new sign-up key: add it to the same user so the policy still applies.
  await parent.createApiKeys({ ...org, userId: user.userId, apiKeys: [{ apiKeyName: `signup-${publicKey.slice(0, 10)}`, publicKey, curveType: "API_KEY_CURVE_P256" }] });
  console.log(`Added the app's new sign-up key to ${SIGNUP_USER_NAME}`);
} else {
  console.log(`${SIGNUP_USER_NAME} already holds this sign-up key`);
}
if (!user) throw new Error("The sign-up user was not found after creating it");
const others = user.apiKeys.filter((k) => k.credential.publicKey !== publicKey);
if (others.length && process.env.KEEP_OTHER_KEYS !== "1") {
  await parent.deleteApiKeys({ ...org, userId: user.userId, apiKeyIds: others.map((k) => k.apiKeyId) });
  console.log(`Removed ${others.length} older sign-up key(s): ${others.map((k) => k.credential.publicKey.slice(0, 12)).join(", ")}`);
}

const policy = signupPolicy(user.userId);
const { policies } = await parent.getPolicies(org);
if (policies.some((p) => p.policyName === policy.policyName)) {
  console.log("Sign-up policy already exists");
} else {
  await parent.createPolicies({ ...org, policies: [policy] });
  console.log("Created the sign-up policy");
}
console.log(`\nGoogle sign-in ready.\n  Organization: ${parentOrg}\n  Sign-up user: ${user.userId}\n  Sign-up public key: ${publicKey}`);
