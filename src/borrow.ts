/**
 * The Earn tab's borrow attempt: Aave's real numbers for the vault, then a borrow the vault's policy refuses.
 *
 * Aave is asked first, by simulating the exact transaction from the vault address (nothing is sent). Only if Aave
 * would lend is the same transaction handed to the vault to sign, so a refusal shown here is the vault's policy
 * (Turnkey, or the stand-in imitating it), never Aave's. Nothing produced here is ever broadcast, and the
 * transaction carries a number no vault address will ever reach, so even an unexpected signature could not land.
 */
import { encodeFunctionData, formatUnits, type Hex } from "viem";
import type { App } from "./app.js";
import { AAVE_MARKETS, ORACLE_ABI, POOL_ABI, aaveApyPercent, type AaveMarket } from "./chains/aave.js";
import { LedgerError } from "./ledger/ledger.js";
import { VaultError, type VaultNote } from "./signer/index.js";
import { TurnkeyVault } from "./signer/turnkey.js";
import { probeTx } from "./proof.js";

/** Aave's health factor when there is no debt: the largest uint256. */
const NO_DEBT = 2n ** 256n - 1n;

export interface BorrowPosition {
  address: string;
  /** The vault address's aWETH: what it has supplied, with interest (wei). */
  supplied: string;
  /** Aave's own figures, in US dollars with 8 decimals. */
  collateralUsd: string;
  debtUsd: string;
  availableUsd: string;
  /** How much of the collateral's value Aave lends against, as a percentage. */
  ltvPercent: number;
  /** Aave's health factor (18 decimals), or null when there is no debt. */
  healthFactor: string | null;
  /** The most of the borrow asset Aave would lend right now (its smallest units), rounded down to a cent. */
  maxBorrow: string;
}

export interface BorrowMarket {
  network: string;
  chainId: number;
  pool: string;
  asset: { symbol: string; address: string; decimals: number };
  /** Aave's variable borrow rate for the asset, compounded yearly (as Aave's site shows it), percent. */
  ratePercent: number;
  /** Aave's oracle prices, US dollars with 8 decimals. */
  ethPriceUsd: string;
  assetPriceUsd: string;
  /** Vault addresses with ETH supplied to Aave. Empty when nothing is earning. */
  positions: BorrowPosition[];
  /** Aave's own pages for the collateral (ETH, showing its lending limit) and the borrow asset (showing its rate). */
  aaveLinks: { collateral: string; borrow: string };
  at: number;
}

/** The most of an asset (smallest units) that `availableUsd` buys at `priceUsd`, rounded down to 0.01. */
export function maxBorrowUnits(availableUsd: bigint, priceUsd: bigint, decimals: number): bigint {
  if (priceUsd <= 0n) return 0n;
  const units = (availableUsd * 10n ** BigInt(decimals)) / priceUsd;
  const cent = decimals >= 2 ? 10n ** BigInt(decimals - 2) : 1n;
  return (units / cent) * cent;
}

/** Aave's refusals by their error code, in plain words. Aave v3 (this market's pool) reverts with named errors. */
const AAVE_ERRORS: Record<string, string> = {
  "0x5b263df7": "the vault address has no collateral on Aave", // LtvValidationFailed
  "0xe43ec917": "the vault address has no collateral on Aave", // CollateralBalanceIsZero
  "0x911ceb81": "the vault's collateral cannot cover that much", // CollateralCannotCoverNewBorrow
  "0x6679996d": "that much would put the vault's position below Aave's safety line", // HealthFactorLowerThanLiquidationThreshold
  "0x77a6a896": "Aave's borrow cap for this asset is reached", // BorrowCapExceeded
  "0x2c5211c6": "the amount is not valid", // InvalidAmount
  "0x53587745": "borrowing this asset is turned off", // BorrowingNotEnabled
  "0x6d305815": "this market is frozen", // ReserveFrozen
  "0xd37f5f1c": "this market is paused", // ReservePaused
};

/** Plain words for why Aave would not lend, from a failed simulation. */
export function aaveRefusal(err: unknown): string {
  let e: unknown = err;
  const seen = new Set<unknown>();
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    const data = (e as { data?: unknown }).data;
    const hex = typeof data === "string" ? data : typeof (data as { data?: unknown })?.data === "string" ? (data as { data: string }).data : undefined;
    if (hex && hex.length >= 10) {
      const known = AAVE_ERRORS[hex.slice(0, 10).toLowerCase()];
      return known ?? `Aave's contract refused it (error ${hex.slice(0, 10)})`;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return `the simulation failed: ${(err as Error)?.message?.split("\n")[0].slice(0, 160) ?? "unknown error"}`;
}

export function borrowMarket(): AaveMarket {
  return AAVE_MARKETS[0];
}

// NEXT PERSON: these pages open this market only once Testnet mode is on in Aave's settings. Aave's read-only
// "watch an address" option was not in its Connect Wallet window on Sept 29, 2026, so the panel links to asset pages.
function aavePage(m: AaveMarket, asset: string): string {
  return `https://app.aave.com/reserve-overview/?underlyingAsset=${asset.toLowerCase()}&marketName=${m.aaveAppMarket}`;
}

let cached: { at: number; value: BorrowMarket } | undefined;

/** Aave's live view of each vault address with ETH supplied: collateral, debt, and the most Aave would lend. */
export async function readBorrowMarket(app: App, maxAgeMs = 10_000): Promise<BorrowMarket> {
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
  const m = borrowMarket();
  const chain = app.chains.get(m.asset)!;
  const client = chain.primary;
  await app.refreshEarn(m.asset);
  const byAddress = app.earnInfo[m.asset]?.byAddress ?? {};
  const [reserve, ethPrice, assetPrice] = await Promise.all([
    client.readContract({ address: m.pool, abi: POOL_ABI, functionName: "getReserveData", args: [m.borrowAsset.address] }),
    client.readContract({ address: m.oracle, abi: ORACLE_ABI, functionName: "getAssetPrice", args: [m.weth] }),
    client.readContract({ address: m.oracle, abi: ORACLE_ABI, functionName: "getAssetPrice", args: [m.borrowAsset.address] }),
  ]);
  const positions: BorrowPosition[] = [];
  for (const [address, supplied] of Object.entries(byAddress)) {
    const [collateral, debt, avail, , ltv, hf] = await client.readContract({ address: m.pool, abi: POOL_ABI, functionName: "getUserAccountData", args: [address as Hex] });
    positions.push({
      address,
      supplied: supplied.toString(),
      collateralUsd: collateral.toString(),
      debtUsd: debt.toString(),
      availableUsd: avail.toString(),
      ltvPercent: Number(ltv) / 100,
      healthFactor: hf === NO_DEBT ? null : hf.toString(),
      maxBorrow: maxBorrowUnits(avail, assetPrice, m.borrowAsset.decimals).toString(),
    });
  }
  positions.sort((a, b) => (BigInt(b.availableUsd) > BigInt(a.availableUsd) ? 1 : -1));
  const value: BorrowMarket = {
    network: m.name,
    chainId: m.chainId,
    pool: m.pool,
    asset: m.borrowAsset,
    ratePercent: aaveApyPercent(reserve.currentVariableBorrowRate),
    ethPriceUsd: ethPrice.toString(),
    assetPriceUsd: assetPrice.toString(),
    positions,
    aaveLinks: { collateral: aavePage(m, m.weth), borrow: aavePage(m, m.borrowAsset.address) },
    at: Date.now(),
  };
  cached = { at: Date.now(), value };
  return value;
}

export interface BorrowAttempt {
  address: string;
  amount: string;
  /** Step 1: would Aave's pool lend this to the vault address right now? */
  aave: { ok: boolean; message: string; ms: number };
  /** Steps 2 and 3: the vault's answer. Absent when Aave would not lend (then the vault is not asked). */
  vault?: {
    outcome: "refused" | "allowed" | "error";
    by: "Turnkey" | "Stand-in vault";
    /** The call the vault's signer asked to sign, in words. */
    call: string;
    message: string;
    policy?: string;
    activityId?: string;
    ms: number;
  };
}

let running = false;

/** Ask Aave, then the vault, to borrow `amount` (smallest units) of the borrow asset against a vault address. */
export async function tryBorrow(app: App, address: string, amount: bigint): Promise<BorrowAttempt> {
  const m = borrowMarket();
  const from = address.toLowerCase();
  if (!app.ledger.depositAddresses().includes(from)) throw new LedgerError("That is not one of the vault's addresses", "NOT_VAULT");
  if (amount <= 0n) throw new LedgerError("Enter an amount to borrow", "BAD_AMOUNT");
  if (running) throw new LedgerError("Another borrow attempt is running. Try again in a moment.", "BUSY");
  running = true;
  try {
    const chain = app.chains.get(m.asset)!;
    const shown = `${formatUnits(amount, m.borrowAsset.decimals)} ${m.borrowAsset.symbol}`;
    const data = encodeFunctionData({ abi: POOL_ABI, functionName: "borrow", args: [m.borrowAsset.address, amount, 2n, 0, from as Hex] });
    const base = { address: from, amount: amount.toString() };

    // 1. Aave: simulate the exact call from the vault address. The gas estimate is that simulation.
    let t0 = Date.now();
    let gas: bigint;
    try {
      gas = await chain.estimateCallGas(from, { to: m.pool, data });
    } catch (err) {
      return { ...base, aave: { ok: false, ms: Date.now() - t0, message: `Aave would not lend ${shown} to vault address ${from}: ${aaveRefusal(err)}. The vault was not asked.` } };
    }
    const aave = { ok: true, ms: Date.now() - t0, message: `Aave's pool on ${m.name} would lend ${shown} to vault address ${from} right now. Checked by simulating the exact transaction; nothing was sent.` };

    // 2 and 3. The vault: the same transaction, to sign. Its policy decides.
    const by = app.vault instanceof TurnkeyVault ? ("Turnkey" as const) : ("Stand-in vault" as const);
    const call = `Aave borrow, ${shown} at a variable rate, owed by vault address ${from}`;
    const note: VaultNote = {};
    t0 = Date.now();
    try {
      await app.vault.signTransaction(from, probeTx(m.chainId, m.pool, 0n, data, gas), note);
      return { ...base, aave, vault: { outcome: "allowed", by, call, ms: Date.now() - t0, activityId: note.activityId, policy: note.policy, message: `${by} signed it. This should never happen. Nothing was sent, and its transaction number can never be used.` } };
    } catch (err) {
      if (err instanceof VaultError) {
        return { ...base, aave, vault: { outcome: "refused", by, call, ms: Date.now() - t0, activityId: err.note.activityId, policy: err.note.policy, message: `${by} refused to sign it, so the vault cannot take on this debt. Nothing was sent.` } };
      }
      return { ...base, aave, vault: { outcome: "error", by, call, ms: Date.now() - t0, message: (err as Error).message.split("\n")[0].slice(0, 200) } };
    }
  } finally {
    running = false;
  }
}
