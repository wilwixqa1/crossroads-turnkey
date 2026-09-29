import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, parseEther, type PublicClient, type TransactionSerializable } from "viem";
import { App } from "../src/app.js";
import { LocalVault } from "../src/signer/index.js";
import { AAVE_MARKETS, POOL_ABI } from "../src/chains/aave.js";
import { aaveRefusal, maxBorrowUnits, readBorrowMarket, tryBorrow } from "../src/borrow.js";
import { NEVER_NONCE } from "../src/proof.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const M = AAVE_MARKETS[0];
const LIMITS = [
  { chainId: 11155111, name: "Sepolia", cap: parseEther("0.05") },
  { chainId: 84532, name: "Base Sepolia", cap: parseEther("0.02") },
];

/** Aave's refusal as viem reports it: the error code sits in a cause's data. */
function aaveRevert(code: string) {
  return Object.assign(new Error("Execution reverted for an unknown reason."), { cause: Object.assign(new Error("execution reverted"), { data: code }) });
}

let dir: string;
let app: App;
let vaultAddress: string;

function useBase(over: Record<string, (...args: any[]) => Promise<unknown>>) {
  const chain = app.chains.get(M.asset)!;
  const client = { estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), ...over };
  chain.clients.splice(0, chain.clients.length, client as unknown as PublicClient, client as unknown as PublicClient);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crossroads-borrow-"));
  app = new App(new LocalVault(MNEMONIC, [], { limits: LIMITS, aave: AAVE_MARKETS }), join(dir, "state.json"));
  vaultAddress = (await app.signUp("0x1111111111111111111111111111111111111111", "Ann")).depositAddress;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("maxBorrowUnits", () => {
  it("converts Aave's dollars to the asset at Aave's price, rounded down to a cent", () => {
    // $44.779 available at USDC $0.99999116: 44.7793... USDC, shown as 44.77.
    expect(maxBorrowUnits(4_477_900_000n, 99_999_116n, 6)).toBe(44_770_000n);
    expect(maxBorrowUnits(0n, 99_999_116n, 6)).toBe(0n);
    expect(maxBorrowUnits(100n, 0n, 6)).toBe(0n);
  });
});

describe("aaveRefusal", () => {
  it("names Aave's refusal from its error code", () => {
    expect(aaveRefusal(aaveRevert("0x5b263df7"))).toMatch(/no collateral/);
    expect(aaveRefusal(aaveRevert("0x911ceb81"))).toMatch(/cannot cover/);
    expect(aaveRefusal(aaveRevert("0xdeadbeef"))).toMatch(/error 0xdeadbeef/);
    expect(aaveRefusal(new Error("network down\nmore"))).toMatch(/network down$/);
  });
});

describe("tryBorrow", () => {
  it("asks Aave first, then the vault, which refuses under the never-borrow rule; nothing is sent", async () => {
    let simulated: { account: unknown; to: unknown; data: unknown } | undefined;
    let sent = false;
    useBase({
      estimateGas: async (a: { account: unknown; to: unknown; data: unknown }) => ((simulated = a), 300_000n),
      sendRawTransaction: async () => ((sent = true), "0x"),
    });
    const r = await tryBorrow(app, vaultAddress, 44_000_000n);
    expect(r.aave.ok).toBe(true);
    expect(String(simulated?.account).toLowerCase()).toBe(vaultAddress.toLowerCase());
    expect(simulated?.to).toBe(M.pool);
    const call = decodeFunctionData({ abi: POOL_ABI, data: simulated!.data as `0x${string}` });
    expect(call.functionName).toBe("borrow");
    const [asset, amount, mode, , onBehalfOf] = call.args as readonly [string, bigint, bigint, number, string];
    expect([asset, amount, mode, onBehalfOf.toLowerCase()]).toEqual([M.borrowAsset.address, 44_000_000n, 2n, vaultAddress.toLowerCase()]);
    expect(r.vault?.outcome).toBe("refused");
    expect(r.vault?.policy).toMatch(/Denied by "Vault signer: never borrow on Aave"/);
    expect(r.vault?.call).toBe(`Aave borrow, 44 USDC at a variable rate, owed by vault address ${vaultAddress.toLowerCase()}`);
    expect(sent).toBe(false);
  });

  it("stops when Aave would not lend, without asking the vault", async () => {
    let asked = false;
    const vault = app.vault as LocalVault;
    const sign = vault.signTransaction.bind(vault);
    vault.signTransaction = async (f: string, tx: TransactionSerializable) => ((asked = true), sign(f, tx));
    useBase({ estimateGas: async () => Promise.reject(aaveRevert("0x5b263df7")) });
    const r = await tryBorrow(app, vaultAddress, 1_000_000n);
    expect(r.aave.ok).toBe(false);
    expect(r.aave.message).toMatch(/no collateral on Aave\. The vault was not asked\./);
    expect(r.vault).toBeUndefined();
    expect(asked).toBe(false);
  });

  it("uses a transaction number no vault address will reach, if the vault ever did sign", async () => {
    const signer = new LocalVault(MNEMONIC, [vaultAddress]); // no rules: signs anything
    app.vault = signer;
    let nonce: number | undefined;
    const sign = signer.signTransaction.bind(signer);
    signer.signTransaction = async (f: string, tx: TransactionSerializable) => ((nonce = tx.nonce), sign(f, tx));
    useBase({ estimateGas: async () => 300_000n });
    const r = await tryBorrow(app, vaultAddress, 1_000_000n);
    expect(r.vault?.outcome).toBe("allowed");
    expect(r.vault?.message).toMatch(/should never happen/);
    expect(nonce).toBe(NEVER_NONCE);
  });

  it("only borrows against the vault's own addresses", async () => {
    await expect(tryBorrow(app, "0x2222222222222222222222222222222222222222", 1n)).rejects.toThrow(/not one of the vault's addresses/);
  });
});

describe("readBorrowMarket", () => {
  it("reports Aave's figures for each vault address with ETH supplied", async () => {
    const reads: Record<string, (args: readonly unknown[]) => unknown> = {
      balanceOf: () => parseEther("0.02"),
      getReserveData: () => ({ currentLiquidityRate: 23n * 10n ** 24n, currentVariableBorrowRate: 123n * 10n ** 23n }),
      getAssetPrice: (args) => ((args[0] as string) === M.weth ? 268_150_657_563n : 99_999_116n),
      getUserAccountData: () => [5_363_013_151n, 0n, 4_478_115_981n, 8_600n, 8_350n, 2n ** 256n - 1n],
    };
    useBase({ readContract: async (a: { functionName: string; args?: readonly unknown[] }) => reads[a.functionName](a.args ?? []) });
    const b = await readBorrowMarket(app, 0);
    expect(b.asset.symbol).toBe("USDC");
    expect(b.ratePercent).toBe(1.24); // 1.23% stored, compounded as Aave's site shows it
    expect(b.positions).toHaveLength(1);
    expect(b.positions[0].address.toLowerCase()).toBe(vaultAddress.toLowerCase());
    expect(b.positions[0]).toMatchObject({ ltvPercent: 83.5, healthFactor: null, maxBorrow: "44780000" });
    expect(b.aaveLinks.borrow).toBe("https://app.aave.com/reserve-overview/?underlyingAsset=0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f&marketName=proto_base_sepolia_v3");
  });
});
