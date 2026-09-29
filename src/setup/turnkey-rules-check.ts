/**
 * Check the vault signer's rules against real Turnkey, for free.
 *
 * Creates a throwaway vault in Will's organization (named "Throwaway: ...") with the app's real rules, adds a rule
 * that refuses every signature, then asks the signer to sign a list of allowed and forbidden transactions and prints
 * Turnkey's own verdict for each rule (getPolicyEvaluations). Everything is refused, so no signature is spent, yet
 * the verdicts show which rule would have allowed or denied each one. Run after changing any rule, before deploying.
 *
 * NEXT PERSON: the throwaway vault is deleted at the end (Will does not want unexplained sub-orgs in his
 * organization). Only a sub-org's own root key can delete it, so never discard these laptop keys before the delete;
 * KEEP_THROWAWAY=1 keeps it for a follow-up run.
 *
 * Settings: TURNKEY_ORG_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY (Will's key), RULES_CHECK_DIR (where the
 * throwaway vault's laptop keys live; default data/rules-check).
 * Run: npm run turnkey:rules
 */
import { rmSync } from "node:fs";
import { encodeFunctionData, parseEther, serializeTransaction, getAddress, type TransactionSerializable, type Hex } from "viem";
import { generateP256KeyPair } from "@turnkey/crypto";
import { turnkeyClient, vaultSubOrgParams, TurnkeyVault, loadOrCreateAppKeys, readVaultOrgId, writeVaultOrgId } from "../signer/turnkey.js";
import { withdrawalLimits } from "../chains/config.js";
import { AAVE_MARKETS, POOL_ABI, GATEWAY_ABI, ERC20_ABI, DEBT_TOKEN_ABI } from "../chains/aave.js";

const dir = process.env.RULES_CHECK_DIR ?? "data/rules-check";
const parentOrg = process.env.TURNKEY_ORG_ID!;
const parent = turnkeyClient({ publicKey: process.env.TURNKEY_API_PUBLIC_KEY!, privateKey: process.env.TURNKEY_API_PRIVATE_KEY! }, parentOrg);
const keys = loadOrCreateAppKeys(dir);
let org = readVaultOrgId(dir);
if (!org) {
  const p = vaultSubOrgParams(parentOrg, keys.admin.publicKey);
  const res = await parent.createSubOrganization({ ...p, subOrganizationName: `Throwaway: Crossroads rules check ${new Date().toISOString().slice(0, 16).replace("T", " ")}` });
  org = res.subOrganizationId;
  writeVaultOrgId(dir, org);
  console.log("created throwaway vault", org);
}
const vault = await TurnkeyVault.open({ organizationId: org, keys, limits: withdrawalLimits(), aave: AAVE_MARKETS }, (l) => console.log("  setup:", l));
console.log("policyProblem:", vault.policyProblem ?? "none");
const admin = turnkeyClient(keys.admin, org);
const signer = turnkeyClient(keys.signer, org);
const { policies } = await admin.getPolicies({ organizationId: org });
if (!policies.some((p) => p.policyName.startsWith("Probe only"))) {
  await admin.createPolicies({ organizationId: org, policies: [{ policyName: "Probe only: refuse every signature", effect: "EFFECT_DENY", consensus: `approvers.any(user, user.id == '${vault.signerUserId}')`, condition: "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'", notes: "Throwaway test vault only." }] });
  console.log("added the refuse-everything rule");
}
const names = new Map((await admin.getPolicies({ organizationId: org })).policies.map((p) => [p.policyId, p.policyName]));
let from = (await vault.addresses())[0];
if (!from) from = (await vault.newDepositAddress()).toLowerCase();
console.log("vault address", from);
const M = AAVE_MARKETS[0];
const OTHER = "0x9999999999999999999999999999999999999999";
const tx = (chainId: number, to: string, value: string, data?: Hex, gas = 21_000n): TransactionSerializable => ({ chainId, type: "eip1559", to: to as Hex, value: parseEther(value), data, nonce: 999_999_999, gas, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n });
const cases: [string, TransactionSerializable][] = [
  ["plain 0.01 Sepolia", tx(11155111, OTHER, "0.01")],
  ["plain 0.06 Sepolia", tx(11155111, OTHER, "0.06")],
  ["plain 0.02 Base", tx(84532, OTHER, "0.02")],
  ["plain 0.03 Base", tx(84532, OTHER, "0.03")],
  ["0.01 Sepolia, 50k gas", tx(11155111, OTHER, "0.01", undefined, 50_000n)],
  ["mainnet 0.001", tx(1, OTHER, "0.001")],
  ["Aave supply for self 0.02", tx(84532, M.gateway, "0.02", encodeFunctionData({ abi: GATEWAY_ABI, functionName: "depositETH", args: [M.pool, from as Hex, 0] }), 300_000n)],
  ["Aave supply for self, checksummed", tx(84532, getAddress(M.gateway), "0.02", encodeFunctionData({ abi: GATEWAY_ABI, functionName: "depositETH", args: [getAddress(M.pool), getAddress(from), 0] }), 300_000n)],
  ["Aave supply for someone else", tx(84532, M.gateway, "0.02", encodeFunctionData({ abi: GATEWAY_ABI, functionName: "depositETH", args: [M.pool, OTHER, 0] }), 300_000n)],
  ["Aave withdraw to self", tx(84532, M.gateway, "0", encodeFunctionData({ abi: GATEWAY_ABI, functionName: "withdrawETH", args: [M.pool, parseEther("0.01"), from as Hex] }), 300_000n)],
  ["Aave withdraw to someone else", tx(84532, M.gateway, "0", encodeFunctionData({ abi: GATEWAY_ABI, functionName: "withdrawETH", args: [M.pool, parseEther("0.01"), OTHER] }), 300_000n)],
  ["approve gateway on aWETH", tx(84532, M.aWeth, "0", encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [M.gateway, parseEther("10")] }), 100_000n)],
  ["approve someone else on aWETH", tx(84532, M.aWeth, "0", encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [OTHER, parseEther("10")] }), 100_000n)],
  ["borrow on pool", tx(84532, M.pool, "0", encodeFunctionData({ abi: POOL_ABI, functionName: "borrow", args: [M.weth, parseEther("0.01"), 2n, 0, from as Hex] }), 400_000n)],
  ["flashLoan on pool", tx(84532, M.pool, "0", encodeFunctionData({ abi: POOL_ABI, functionName: "flashLoan", args: [OTHER, [M.weth], [1n], [2n], from as Hex, "0x", 0] }), 400_000n)],
  ["borrowETH on gateway", tx(84532, M.gateway, "0", encodeFunctionData({ abi: GATEWAY_ABI, functionName: "borrowETH", args: [M.pool, 1n, 0] }), 400_000n)],
  ["approveDelegation", tx(84532, M.vDebt, "0", encodeFunctionData({ abi: DEBT_TOKEN_ABI, functionName: "approveDelegation", args: [OTHER, 1n] }), 100_000n)],
];
const short = (n: string) => n.replace("Vault signer: ", "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const [label, t] of cases) {
  await sleep(3500);
  let outcome = "";
  try {
    await signer.signTransaction({ organizationId: org, signWith: getAddress(from), unsignedTransaction: serializeTransaction(t).slice(2), type: "TRANSACTION_TYPE_ETHEREUM" });
    outcome = "SIGNED (unexpected)";
  } catch (e) {
    outcome = /sufficient permissions/i.test((e as Error).message) ? "refused" : "ERROR " + (e as Error).message.slice(0, 120);
  }
  await sleep(1500);
  const { activities } = await admin.getActivities({ organizationId: org, filterByType: ["ACTIVITY_TYPE_SIGN_TRANSACTION_V2"], paginationOptions: { limit: "1" } });
  await sleep(800);
  const ev = await admin.getPolicyEvaluations({ organizationId: org, activityId: activities[0].id });
  const verdicts = (ev.policyEvaluations ?? []).flatMap((e) => e.policyEvaluations ?? []).filter((p) => p.outcome !== "OUTCOME_DENY_IMPLICIT" && !names.get(p.policyId!)?.startsWith("Probe only")).map((p) => `${p.outcome!.replace("OUTCOME_", "")}: ${short(names.get(p.policyId!) ?? p.policyId!)}`);
  console.log(`${label.padEnd(36)} ${outcome.padEnd(8)} ${verdicts.join(" ; ") || "(no rule matched)"}`);
}
// export
try {
  await signer.exportWallet({ organizationId: org, walletId: vault.walletId, targetPublicKey: generateP256KeyPair().publicKeyUncompressed });
  console.log("export: EXPORTED (unexpected)");
} catch (e) {
  console.log("export:", (e as Error).message.slice(0, 140));
}
const { activities: ex } = await admin.getActivities({ organizationId: org, filterByType: ["ACTIVITY_TYPE_EXPORT_WALLET"], paginationOptions: { limit: "1" } });
console.log("export activity:", ex[0]?.id, ex[0]?.status);

if (process.env.KEEP_THROWAWAY !== "1") {
  await admin.deleteSubOrganization({ organizationId: org, deleteWithoutExport: true });
  rmSync(dir, { recursive: true, force: true });
  console.log(`deleted the throwaway vault ${org}`);
}
