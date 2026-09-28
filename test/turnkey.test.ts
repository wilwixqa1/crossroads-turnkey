import { describe, it, expect } from "vitest";
import { parseEther, type TransactionSerializable } from "viem";
import { TurnkeyVault, apiKeyFromRaw, type TurnkeyCalls } from "../src/signer/turnkey.js";
import { signerPolicies, names } from "../src/signer/policy.js";
import { AAVE_MARKETS } from "../src/chains/aave.js";
import { VaultError, type VaultNote } from "../src/signer/index.js";

const CAP = parseEther("0.05");

/** An in-memory stand-in for the vault sub-organization, recording what the app asked Turnkey to do. */
function fakeTurnkey(seed: { policies?: Policy[] } = {}) {
  const org = {
    wallets: [] as { walletId: string; walletName: string }[],
    accounts: [] as { address: string; path: string }[],
    users: [] as { userId: string; userName: string }[],
    policies: [...(seed.policies ?? [])] as Policy[],
    interfaces: [] as { smartContractAddress: string; label: string }[],
    signed: [] as { signWith: string; unsignedTransaction: string }[],
    refuse: false,
    failPolicies: false,
    /** What Turnkey's policy evaluation reports for the next activity, by policy name. */
    evaluation: [] as { name: string; outcome: string }[],
  };
  let nextPolicy = 100;
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
    createPolicies: async (i: { policies: Omit<Policy, "policyId">[] }) => {
      if (org.failPolicies) throw new Error("Turnkey error 3: invalid policy condition");
      const created = i.policies.map((p) => ({ ...p, policyId: `policy-${nextPolicy++}` }));
      org.policies.push(...created);
      return { policyIds: created.map((p) => p.policyId) };
    },
    deletePolicy: async (i: { policyId: string }) => {
      org.policies = org.policies.filter((p) => p.policyId !== i.policyId);
      return { policyId: i.policyId };
    },
    getSmartContractInterfaces: async () => ({ smartContractInterfaces: org.interfaces }),
    createSmartContractInterface: async (i: { smartContractAddress: string; label: string }) => {
      org.interfaces.push({ smartContractAddress: i.smartContractAddress, label: i.label });
      return { smartContractInterfaceId: `sci-${org.interfaces.length}` };
    },
    signTransaction: async (i: { signWith: string; unsignedTransaction: string }) => {
      if (org.refuse) throw new Error("Turnkey error 7: You don't have sufficient permissions to take this action.");
      org.signed.push(i);
      return { signedTransaction: "02f8ab", activity: { id: "act-signed-1" } };
    },
    getActivities: async () => ({ activities: [{ id: "act-rejected-1" }] }),
    getPolicyEvaluations: async () => ({
      policyEvaluations: [{ policyEvaluations: org.evaluation.map((e) => ({ policyId: org.policies.find((p) => p.policyName === e.name)?.policyId, outcome: e.outcome })) }],
    }),
  } as unknown as TurnkeyCalls;
  return { org, client };
}

type Policy = { policyId: string; policyName: string; effect: string; condition: string; consensus: string };

const keys = { admin: apiKeyFromRaw(new Uint8Array(32).fill(1)), signer: apiKeyFromRaw(new Uint8Array(32).fill(2)) };
const LIMITS = [
  { chainId: 11155111, name: "Sepolia", cap: CAP },
  { chainId: 84532, name: "Base Sepolia", cap: parseEther("0.02") },
];
const open = (client: TurnkeyCalls) => TurnkeyVault.open({ organizationId: "vault-org", keys, limits: LIMITS, aave: AAVE_MARKETS, clients: { admin: client, signer: client } });
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
  it("allow a plain transfer up to each network's own limit, and deny anything above it", () => {
    const ps = signerPolicies("signer-1", "wallet-1", LIMITS);
    expect(ps.map((p) => p.policyName)).toEqual([
      "Vault signer: withdrawals on Sepolia, up to 0.05 ETH",
      "Vault signer: never more than 0.05 ETH per withdrawal on Sepolia",
      "Vault signer: withdrawals on Base Sepolia, up to 0.02 ETH",
      "Vault signer: never more than 0.02 ETH per withdrawal on Base Sepolia",
    ]);
    const [allow, deny, baseAllow, baseDeny] = ps;
    expect(allow.consensus).toContain("'signer-1'");
    expect(allow.condition).toContain("wallet.id == 'wallet-1'");
    expect(allow.condition).toContain(`eth.tx.chain_id == 11155111 && eth.tx.value <= ${CAP} && eth.tx.gas == 21000`);
    expect(deny.effect).toBe("EFFECT_DENY");
    expect(deny.condition).toContain(`eth.tx.chain_id == 11155111 && eth.tx.value > ${CAP}`);
    expect(baseAllow.condition).toContain(`eth.tx.chain_id == 84532 && eth.tx.value <= ${parseEther("0.02")}`);
    expect(baseDeny.condition).toContain(`eth.tx.value > ${parseEther("0.02")}`);
    for (const p of ps) expect(p.condition).toContain("ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
  });

  it("allow Aave supply and withdraw only for the vault itself, and deny every way to borrow", () => {
    const ps = signerPolicies("signer-1", "wallet-1", LIMITS, AAVE_MARKETS);
    const supply = ps.find((p) => p.policyName === names.aaveSupply)!;
    expect(supply.condition).toContain("eth.tx.contract_call_args['onBehalfOf'] == eth.tx.from");
    expect(supply.condition).toContain("eth.tx.contract_call_args['to'] == eth.tx.from");
    expect(supply.condition).toContain("'0x387d311e47e80b498169e6fb51d3193167d89f7d', '0x387d311e47e80b498169e6fb51d3193167d89F7D'");
    const never = ps.find((p) => p.policyName === names.neverBorrow)!;
    expect(never.effect).toBe("EFFECT_DENY");
    for (const f of ["'borrow'", "'flashLoan'", "'flashLoanSimple'", "'borrowETH'", "'approveDelegation'"]) expect(never.condition).toContain(f);
  });
});

describe("the Turnkey vault", () => {
  it("creates its wallet, signer, contract interfaces and policies once, and nothing on later starts", async () => {
    const { org, client } = fakeTurnkey();
    const first = await open(client);
    expect([org.wallets.length, org.users.length, org.interfaces.length, org.policies.length]).toEqual([1, 1, 4, 7]);
    const again = await open(client);
    expect([org.wallets.length, org.users.length, org.interfaces.length, org.policies.length]).toEqual([1, 1, 4, 7]);
    expect([again.walletId, again.signerUserId]).toEqual([first.walletId, first.signerUserId]);
  });

  it("replaces the old single-limit policies with per-network ones, and leaves other policies alone", async () => {
    const signer = "approvers.any(user, user.id == 'signer-1')";
    const old: Policy[] = [
      { policyId: "old-1", policyName: "Vault signer: withdrawals on Sepolia and Base Sepolia", effect: "EFFECT_ALLOW", condition: "eth.tx.value <= 1", consensus: signer },
      { policyId: "old-2", policyName: "Vault signer: never more than 0.05 ETH per withdrawal", effect: "EFFECT_DENY", condition: "eth.tx.value > 1", consensus: signer },
      { policyId: "other", policyName: "Someone else's policy", effect: "EFFECT_ALLOW", condition: "true", consensus: "approvers.any(user, user.id == 'x')" },
    ];
    const { org, client } = fakeTurnkey({ policies: old });
    org.users.push({ userId: "signer-1", userName: "app-signer" });
    await open(client);
    const namesNow = org.policies.map((p) => p.policyName);
    expect(namesNow).not.toContain("Vault signer: withdrawals on Sepolia and Base Sepolia");
    expect(namesNow).toContain("Vault signer: withdrawals on Base Sepolia, up to 0.02 ETH");
    expect(namesNow).toContain("Someone else's policy");
    expect(org.policies).toHaveLength(8);
  });

  it("still opens, on its old policies, when Turnkey refuses the new ones", async () => {
    const signer = "approvers.any(user, user.id == 'signer-1')";
    const old: Policy[] = [{ policyId: "old-1", policyName: "Vault signer: withdrawals on Sepolia and Base Sepolia", effect: "EFFECT_ALLOW", condition: "eth.tx.value <= 1", consensus: signer }];
    const { org, client } = fakeTurnkey({ policies: old });
    org.users.push({ userId: "signer-1", userName: "app-signer" });
    org.failPolicies = true;
    const vault = await open(client);
    expect(vault.policyProblem).toMatch(/invalid policy condition/);
    expect(org.policies.map((p) => p.policyId)).toEqual(["old-1"]);
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

  it("says which network's limit a refused request broke", async () => {
    const { org, client } = fakeTurnkey();
    const vault = await open(client);
    org.refuse = true;
    await expect(vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.06"))).rejects.toThrow("0.06 ETH is above the 0.05 ETH per-withdrawal limit on Sepolia");
    await expect(vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.03", 84532))).rejects.toThrow("0.03 ETH is above the 0.02 ETH per-withdrawal limit on Base Sepolia");
    await expect(vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.01", 1))).rejects.toThrow("chain 1 is not one the vault may sign for");
  });

  it("names the policy Turnkey says decided, for a signature and for a refusal", async () => {
    const { org, client } = fakeTurnkey();
    const vault = await open(client);
    const note: VaultNote = {};
    org.evaluation = [{ name: "Vault signer: withdrawals on Sepolia, up to 0.05 ETH", outcome: "OUTCOME_ALLOW" }];
    await vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.01"), note);
    expect(note.activityId).toBe("act-signed-1");
    expect(note.policy).toBe('Allowed by "Vault signer: withdrawals on Sepolia, up to 0.05 ETH" (0.01 ETH, within the 0.05 ETH limit on Sepolia)');
    org.refuse = true;
    org.evaluation = [{ name: "Vault signer: never more than 0.05 ETH per withdrawal on Sepolia", outcome: "OUTCOME_DENY_EXPLICIT" }];
    const err = await vault.signTransaction("0x8928feb8852339fb84fb88095a388759de2f8a9f", tx("0.06")).catch((e) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect(err.note).toMatchObject({ activityId: "act-rejected-1", policy: 'Denied by "Vault signer: never more than 0.05 ETH per withdrawal on Sepolia"' });
  });
});
