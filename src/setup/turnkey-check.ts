/**
 * Phase 1 checks against the live vault. Each line should come out as expected:
 *   the signer can sign a small Sepolia withdrawal; Turnkey refuses one above the cap; Turnkey refuses
 *   another chain; Will's parent organization can read the vault but cannot sign with it.
 *
 * Nothing is broadcast. Every test transaction uses an absurd transaction number, so even the one allowed
 * signature can never be used on-chain. That allowed signature is billable; refused ones should not be.
 */
import { dirname, join } from "node:path";
import { parseEther, type TransactionSerializable } from "viem";
import { WITHDRAWAL_CAP } from "../app.js";
import { CHAINS } from "../chains/config.js";
import { TurnkeyVault, loadOrCreateAppKeys, readVaultOrgId, turnkeyClient } from "../signer/turnkey.js";

const dir = dirname(process.env.STATE_PATH ?? join(process.cwd(), "data", "state.json"));
const organizationId = readVaultOrgId(dir);
if (!organizationId) throw new Error("No vault yet: run the setup first");
const vault = await TurnkeyVault.open({ organizationId, keys: loadOrCreateAppKeys(dir), cap: WITHDRAWAL_CAP, chainIds: CHAINS.map((c) => c.chain.id) });
const from = (await vault.addresses())[0] ?? (await vault.newDepositAddress());

const tx = (chainId: number, eth: string): TransactionSerializable => ({
  chainId, type: "eip1559", to: from as `0x${string}`, value: parseEther(eth), nonce: 999_999_999, gas: 21_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n,
});

let failures = 0;
async function expect(name: string, shouldSucceed: boolean, attempt: () => Promise<unknown>, verb = "signed") {
  let signed = false;
  let detail = "";
  try {
    await attempt();
    signed = true;
  } catch (err) {
    detail = (err as Error).message.split("\n")[0].slice(0, 220);
  }
  const ok = signed === shouldSucceed;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${signed ? verb : `refused (${detail})`}`);
}

await expect("Signer signs 0.01 ETH on Sepolia", true, () => vault.signTransaction(from, tx(11155111, "0.01")));
await expect("Signer asks for 0.06 ETH on Sepolia, above the cap", false, () => vault.signTransaction(from, tx(11155111, "0.06")));
await expect("Signer asks for 0.01 ETH on Ethereum mainnet", false, () => vault.signTransaction(from, tx(1, "0.01")));

const parentOrg = process.env.TURNKEY_ORG_ID;
if (parentOrg && process.env.TURNKEY_API_PUBLIC_KEY && process.env.TURNKEY_API_PRIVATE_KEY) {
  const parent = turnkeyClient({ publicKey: process.env.TURNKEY_API_PUBLIC_KEY, privateKey: process.env.TURNKEY_API_PRIVATE_KEY }, organizationId);
  await expect("Parent organization reads the vault wallet", true, () => parent.getWalletAccounts({ organizationId, walletId: vault.walletId }), "allowed");
  await expect("Parent organization tries to sign 0.01 ETH with the vault", false, async () => {
    const { serializeTransaction } = await import("viem");
    return parent.signTransaction({ organizationId, signWith: from, unsignedTransaction: serializeTransaction(tx(11155111, "0.01")).slice(2), type: "TRANSACTION_TYPE_ETHEREUM" });
  });
}
console.log(failures ? `\n${failures} check(s) did not behave as expected` : "\nAll checks behaved as expected");
process.exitCode = failures ? 1 : 0;
