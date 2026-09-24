import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { hashMessage, verifyMessage } from "viem";
import { UserDirectory, signupPolicy, type SignupCalls } from "../src/auth/google.js";
import { nonceFor, signatureFromTurnkey } from "../web/google.js";

const PUBLIC_KEY = "02" + "ab".repeat(32);
const token = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

/** An in-memory stand-in for Will's organization, recording what the sign-up key asked Turnkey to do. */
function fakeParent(existing?: { orgId: string; address: string }) {
  const calls: { created: Record<string, unknown>[]; logins: Record<string, unknown>[] } = { created: [], logins: [] };
  const client = {
    getSubOrgIds: async (i: { filterType: string }) => ({ organizationIds: existing && i.filterType === "OIDC_TOKEN" ? [existing.orgId] : [] }),
    createSubOrganization: async (i: Record<string, unknown>) => {
      calls.created.push(i);
      return { subOrganizationId: "user-org-1", wallet: { walletId: "w1", addresses: ["0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD"] } };
    },
    getWallets: async () => ({ wallets: [{ walletId: "w1", walletName: "Crossroads wallet" }] }),
    getWalletAccounts: async () => ({ accounts: [{ address: existing?.address ?? "", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] }),
    oauthLogin: async (i: Record<string, unknown>) => {
      calls.logins.push(i);
      return { session: "session-jwt" };
    },
  } as unknown as SignupCalls;
  return { client, calls };
}

describe("Google sign-in through Turnkey", () => {
  it("creates a wallet on first sign-in whose only way in is the Google account, then opens a session for the browser's key", async () => {
    const { client, calls } = fakeParent();
    const s = await new UserDirectory("will-org", client).signIn(token({ sub: "1", name: "Will Wendt" }), PUBLIC_KEY);
    expect(s).toMatchObject({ organizationId: "user-org-1", address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", name: "Will Wendt", session: "session-jwt", created: true });
    const created = calls.created[0] as { rootUsers: { oauthProviders: { providerName: string }[]; apiKeys: unknown[] }[]; disableEmailRecovery: boolean; disableEmailAuth: boolean };
    expect(created.rootUsers[0].oauthProviders[0].providerName).toBe("Google");
    expect(created.rootUsers[0].apiKeys).toEqual([]);
    expect(created.disableEmailRecovery && created.disableEmailAuth).toBe(true);
    expect(calls.logins[0]).toMatchObject({ organizationId: "user-org-1", publicKey: PUBLIC_KEY });
  });

  it("finds a returning user's wallet instead of making another one", async () => {
    const { client, calls } = fakeParent({ orgId: "user-org-9", address: "0x1111111111111111111111111111111111111111" });
    const s = await new UserDirectory("will-org", client).signIn(token({ sub: "1", email: "will@example.com" }), PUBLIC_KEY);
    expect(calls.created).toHaveLength(0);
    expect(s).toMatchObject({ organizationId: "user-org-9", address: "0x1111111111111111111111111111111111111111", name: "will", created: false });
  });

  it("refuses a session key that is not a compressed P-256 key", async () => {
    const { client } = fakeParent();
    await expect(new UserDirectory("will-org", client).signIn(token({}), "04" + "ab".repeat(64))).rejects.toThrow(/compressed/);
  });

  it("gives the sign-up key only sub-organization creation and login starts", () => {
    const p = signupPolicy("signup-user");
    expect(p.consensus).toContain("signup-user");
    expect(p.condition).toBe("(activity.resource == 'ORGANIZATION' && activity.action == 'CREATE') || (activity.resource == 'AUTH' && activity.action == 'CREATE')");
  });

  it("computes the nonce the way Turnkey's documentation example does (hash of the key's hex text)", async () => {
    const key = "04bb76f9a8aaafbb0722fa184f66642ae425e2a032bde8ffa0479ff5a93157b204c7848701cf246d81fd58f6c4c47a437d9f81e6a183042f2f1aa2f6aa28e4ab65";
    expect(await nonceFor(key)).toBe("1f9570d976946c0cb72f0e853eea0fb648b5e9e9a2266d25f971817e187c9b18");
  });

  it("turns Turnkey's r, s, v into a signature the app accepts for the wallet's address", async () => {
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    const message = "Crossroads Demo\naccount: x\nseq: 1\naction: transfer";
    for (let i = 0; i < 4; i++) {
      const m = `${message}${i}`;
      const sig = await sign({ hash: hashMessage(m), privateKey });
      // Turnkey's shape: bare hex, v as 00 or 01.
      const tk = { r: sig.r.slice(2), s: sig.s.slice(2), v: sig.yParity === 1 ? "01" : "00" };
      expect(await verifyMessage({ address, message: m, signature: signatureFromTurnkey(tk) })).toBe(true);
    }
  });
});
