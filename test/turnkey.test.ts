import { describe, it, expect } from "vitest";
import { parseEther, type TransactionSerializable } from "viem";
import { TurnkeyVault, apiKeyFromRaw, signerPolicies, type TurnkeyCalls } from "../src/signer/turnkey.js";
import { VaultError, type VaultNote } from "../src/signer/index.js";

const CAP = parseEther("0.05");
const CHAINS = [11155111, 84532];

/** An in-memory stand-in for the vault sub-organization, recording what the app asked Turnkey to do. */
function fakeTurnkey() {
  const org = {
    wallets: [] as { walletId: string; walletName: string }[],
    accounts: [] as { address: string; path: string }[],
    users: [] as { userId: string; userName: string }[],
    policies: [] as { policyName: string; effect: string; condition: string }[],
    signed: [] as { signWith: string; unsignedTransaction: string }[],
    refuse: false,
  };
  const client = {
    getWallets: async () => ({ wallets: org.wallets }),
    createWallet: async (i: { walletName: string }) => {
      org.wallets.push({ walletId: "wallet-1", walletName: i.walletName });
      return { walletId: "wallet-1", addresses: [] };
    },
    getWalletAccounts: async () => ({ accounts: [...org.accounts] }),
    createWalletAccounts: async (i: { accounts: { path: string }[] }) => {
      await new Promise((r) => setTimeout(r, 5)); // slow enough that overlapping sign-ups would collide without the queue
      const address = `0x${(org.accounts.length + 1).toString(16).padStart(40, "a")}`;
      org.accounts.push({ address, path: i.accounts[0].path });
      return { addresses: [address] };
    },
    getUsers: async () => ({ users: org.users }),
    createUsers: async (i: { users: { userName: string }[] }) => {
      org.users.push({ userId: "signer-1", userName: i.users[0].userName });
      return { userIds: ["signer-1"] };
    },
    getPolicies: async () => ({ policies: org.policies }),
    createPolicies: async (i: { policies: { policyName: string; effect: string; condition: string }[] }) => {
      org.policies.push(...i.policies);
      return { policyIds: i.policies.map((_, n) => `policy-${n}`) };
    },
    signTransaction: async (i: { signWith: string; unsignedTransaction: string }) => {
      if (org.refuse) throw new Error("Turnkey error 7: You don't have sufficient permissions to take this action.");
      org.signed.push(i);
      return { signedTransaction: "02f8ab", activity: { id: "act-signed-1" } };
    },
    getActivities: async () => ({ activities: [{ id: "act-rejected-1" }] }),
  } as unknown as TurnkeyCalls;
  return { org, client };
}

const keys = { admin: apiKeyFromRaw(new Uint8Array(32).fill(1)), signer: apiKeyFromRaw(new Uint8Array(32).fill(2)) };
const open = (client: TurnkeyCalls) => TurnkeyVault.open({ organizationId: "vault-org", keys, cap: CAP, chainIds: CHAINS, clients: { admin: client, signer: client } });
const tx = (value: string, chainId = 11155111): TransactionSerializable => ({ chainId, type: "eip1559", to: "0x9999999999999999999999999999999999999999", value: parseEther(value), nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });

describe("the app's Turnkey keys", () => {
  it("builds a Turnkey API key from 32 raw bytes, the form ROFL hands the app", () => {
    const k = apiKeyFromRaw(new Uint8Array(32).fill(7));
    expect(k.privateKey).toHaveLength(64);
    expect(k.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(() => apiKeyFromRaw(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => apiKeyFromRaw(new Uint8Array(32))).toThrow();
  });
});

describe("the signer's policies", () => {
  it("allow only the vault wallet on the two chains up to the cap, and deny anything above the cap", () => {
    const [allow, deny] = signerPolicies("signer-1", "wallet-1", CAP, CHAINS);
    expect(allow.effect).toBe("EFFECT_ALLOW");
    expect(allow.consensus).toContain("'signer-1'");
    expect(allow.condition).toContain("wallet.id == 'wallet-1'");
    expect(allow.condition).toContain("eth.tx.chain_id == 11155111 || eth.tx.chain_id == 84532");
    expect(allow.condition).toContain(`eth.tx.value <= ${CAP}`);
    expect(deny.effect).toBe("EFFECT_DENY");
    expect(deny.condition).toContain(`eth.tx.value > ${CAP}`);
    for (const p of [allow, deny]) expect(p.condition).toContain("ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
  });
});

describe("the Turnkey vault", () => {
  it("creates its wallet, signer and policies once, and nothing on later starts", async () => {
    const { org, client } = fakeTurnkey();
    const first = await open(client);
    expect([org.wallets.length, org.users.length, org.policies.length]).toEqual([1, 1, 2]);
    const again = await open(client);
    expect([org.wallets.length, org.users.length, org.policies.length]).toEqual([1, 1, 2]);
    expect([again.walletId, again.signerUserId]).toEqual([first.walletId, first.signerUserId]);
  });

  it("gives overlapping sign-ups different deposit addresses", async () => {
    const { org, client } = fakeTurnkey();
    const vault = await open(client);
    const [a, b, c] = await Promise.all([vault.newDepositAddress(), vault.newDepositAddress(), vault.newDepositAddress()]);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(org.accounts.map((x) => x.path)).toEqual(["m/44'/60'/0'/0/0", "m/44'/60'/0'/0/1", "m/44'/60'/0'/0/2"]);
  });

  it("signs with the checksummed vault address and returns a broadcastable transaction", async () => {
    const { org, client } = fakeTurnkey();
    const vault = await open(client);
    const signed = await vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.01"));
    expect(signed).toBe("0x02f8ab");
    expect(org.signed[0].signWith).toBe("0x8928Feb8852339FB84FB88095a388759DE2F8A9f");
    expect(org.signed[0].unsignedTransaction.startsWith("0x")).toBe(false);
  });

  it("says which limit a refused request broke", async () => {
    const { org, client } = fakeTurnkey();
    const vault = await open(client);
    org.refuse = true;
    await expect(vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.06"))).rejects.toThrow("0.06 ETH is above the 0.05 ETH per-withdrawal cap");
    await expect(vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.01", 1))).rejects.toThrow("chain 1 is not one the vault may sign for");
  });

  it("reports the Turnkey activity and the policy by name, for a signature and for a refusal", async () => {
    const { org, client } = fakeTurnkey();
    const vault = await open(client);
    const note: VaultNote = {};
    await vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.01"), note);
    expect(note.activityId).toBe("act-signed-1");
    expect(note.policy).toBe('Allowed by "Vault signer: withdrawals on Sepolia and Base Sepolia" (0.01 ETH, within the 0.05 ETH cap)');
    org.refuse = true;
    const err = await vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.06")).catch((e) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect(err.note).toEqual({ activityId: "act-rejected-1", policy: 'Denied by "Vault signer: never more than 0.05 ETH per withdrawal"' });
  });
});
