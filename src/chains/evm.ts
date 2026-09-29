/**
 * One EVM chain (Sepolia or Base Sepolia): find deposits, send withdrawals.
 *
 * Deposits: the first RPC provider scans confirmed blocks for plain ETH transfers
 * to any vault address. Every candidate is then re-checked against a second,
 * independent provider (receipt must succeed, recipient and amount must match).
 * Only when both agree is the deposit handed to the ledger. This is the demo's
 * stand-in for Crossroads' finalization oracle.
 *
 * Withdrawals: build a plain transfer with the vault address's current nonce,
 * hand it to the Vault to sign, broadcast, and later report the real fee.
 */
import { createPublicClient, http, formatEther, keccak256, type PublicClient, type Hex, type TransactionSerializable } from "viem";
import type { ChainConfig } from "./config.js";
import { VaultError, type Vault, type VaultNote } from "../signer/index.js";
import { ERC20_ABI, POOL_ABI } from "./aave.js";

export interface FoundDeposit {
  asset: ChainConfig["asset"];
  txHash: string;
  to: string;
  from: string;
  amount: bigint;
  blockNumber: bigint;
}

export interface SentWithdrawal {
  txHash: string;
  fromAddress: string;
  nonce: number;
  /** Set when the network errored on broadcast. The transaction may still land, so funds must stay locked. */
  broadcastError?: string;
}

export type WithdrawalResult =
  | { state: "unknown" }
  | { state: "unconfirmed" }
  | { state: "done"; feeActual: bigint; success: boolean };

/** The vault (Turnkey, or the stand-in) declined to sign. Distinct from network errors so the UI can say who refused. */
export class VaultRefusal extends Error {
  constructor(message: string, readonly note: VaultNote = {}) {
    super(message);
  }
}

/**
 * What a transaction really cost its sender. On Base (an OP-stack chain) that is the gas fee plus an L1 data fee,
 * which the receipt reports separately; leaving it out makes the ledger think the vault holds a few gwei more than
 * it does on every Base transaction, and the proof page's solvency check reads "Short".
 */
// NEXT PERSON: a local anvil fork of Base Sepolia charges this L1 fee but reports none in the receipt, so the proof
// page reads Short on laptop runs. Start that fork with --network ethereum; live Base Sepolia reports l1Fee.
export function feePaid(receipt: { gasUsed: bigint; effectiveGasPrice: bigint; l1Fee?: bigint | null }): bigint {
  return receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n);
}

export class EvmChain {
  readonly clients: PublicClient[];

  constructor(readonly cfg: ChainConfig) {
    if (cfg.rpcUrls.length < 2) throw new Error(`${cfg.asset}: need at least two RPC providers to cross-check`);
    this.clients = cfg.rpcUrls.map((url) => createPublicClient({ chain: cfg.chain, transport: http(url, { timeout: 15_000 }) }));
  }

  get primary() {
    return this.clients[0];
  }
  get secondary() {
    return this.clients[1];
  }

  /** Newest block the primary provider knows about. Blocks at or below `latest - confirmations` count as confirmed. */
  async latestHead(): Promise<bigint> {
    return this.primary.getBlockNumber();
  }

  /**
   * Scan blocks (from, to] for ETH transfers into any watched address, and
   * cross-check each with the second provider. With crossCheck=false the scan is
   * only a heads-up for the page ("deposit seen, waiting for confirmations") and
   * must never be used to credit the ledger.
   */
  async scanDeposits(fromBlockExclusive: bigint, toBlockInclusive: bigint, watched: Set<string>, crossCheck = true): Promise<FoundDeposit[]> {
    const found: FoundDeposit[] = [];
    if (watched.size === 0) return found;
    for (let n = fromBlockExclusive + 1n; n <= toBlockInclusive; n++) {
      const block = await this.primary.getBlock({ blockNumber: n, includeTransactions: true });
      for (const tx of block.transactions) {
        if (typeof tx === "string") continue;
        if (!tx.to || tx.value === 0n) continue;
        const to = tx.to.toLowerCase();
        if (!watched.has(to)) continue;
        if (crossCheck && !(await this.crossCheck(tx.hash, to, tx.value))) continue;
        found.push({ asset: this.cfg.asset, txHash: tx.hash, to, from: tx.from.toLowerCase(), amount: tx.value, blockNumber: n });
      }
    }
    return found;
  }

  /**
   * A second, independent provider must report a successful transfer of the same amount to the same address.
   * The other providers are asked in order until one answers. If none answers, this throws so the scan is retried
   * later: an unreachable provider must never count as "not a deposit".
   */
  private async crossCheck(hash: Hex, to: string, amount: bigint): Promise<boolean> {
    const errors: string[] = [];
    for (const client of this.clients.slice(1)) {
      try {
        const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
        return receipt.status === "success" && !!tx.to && tx.to.toLowerCase() === to && tx.value === amount;
      } catch (err) {
        errors.push((err as Error).message.split("\n")[0].slice(0, 80));
      }
    }
    throw new Error(`no second provider could confirm ${hash}: ${errors.join("; ")}`);
  }

  /**
   * One deposit by its transaction hash, for crediting a deposit a scan missed. The primary provider supplies it,
   * a second provider must agree, and it must have the chain's confirmations. Returns undefined if it is not a
   * confirmed, successful plain transfer into one of the watched addresses.
   */
  async depositByHash(hash: Hex, watched: Set<string>): Promise<FoundDeposit | undefined> {
    const [tx, receipt, latest] = await Promise.all([this.primary.getTransaction({ hash }), this.primary.getTransactionReceipt({ hash }), this.primary.getBlockNumber()]);
    const to = tx.to?.toLowerCase();
    if (!to || !watched.has(to) || tx.value === 0n || receipt.status !== "success") return undefined;
    if (latest - receipt.blockNumber < BigInt(this.cfg.confirmations)) throw new Error(`not enough confirmations yet (needs ${this.cfg.confirmations})`);
    if (!(await this.crossCheck(hash, to, tx.value))) return undefined;
    return { asset: this.cfg.asset, txHash: tx.hash, to, from: tx.from.toLowerCase(), amount: tx.value, blockNumber: receipt.blockNumber };
  }

  /** Conservative fee reserve for a plain transfer, in wei. */
  async estimateWithdrawalFee(): Promise<bigint> {
    const fees = await this.primary.estimateFeesPerGas();
    const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 1_000_000_000n;
    return perGas * 21_000n * 2n; // 2x headroom; unused reserve is refunded on completion
  }

  /**
   * Build, sign (via the vault), and broadcast a withdrawal. Throws VaultRefusal if the vault will not
   * sign; nothing has been signed in that case. Once signed, this never throws: a broadcast error is
   * returned instead, because the transaction may still reach the chain.
   */
  async sendWithdrawal(vault: Vault, fromAddress: string, to: string, amount: bigint, note?: VaultNote): Promise<SentWithdrawal> {
    return this.sendFromVault(vault, fromAddress, { to: to as Hex, value: amount, gas: 21_000n }, note);
  }

  /** Estimate a contract call's gas from a vault address, with 30% headroom (Aave's gas use varies a little). */
  async estimateCallGas(fromAddress: string, call: { to: Hex; data: Hex; value?: bigint }): Promise<bigint> {
    const gas = await this.primary.estimateGas({ account: fromAddress as Hex, to: call.to, data: call.data, value: call.value ?? 0n });
    return (gas * 13n) / 10n;
  }

  /** Worst-case network fee for a call with this much gas, at today's fee levels. */
  async feeFor(gas: bigint): Promise<bigint> {
    const fees = await this.primary.estimateFeesPerGas();
    return gas * fees.maxFeePerGas;
  }

  /** Have the vault sign a transaction from one of its addresses and broadcast it. The vault's policy decides. */
  async sendFromVault(vault: Vault, fromAddress: string, call: { to: Hex; value?: bigint; data?: Hex; gas: bigint }, note?: VaultNote): Promise<SentWithdrawal> {
    const [nonce, fees] = await Promise.all([
      this.primary.getTransactionCount({ address: fromAddress as Hex, blockTag: "pending" }),
      this.primary.estimateFeesPerGas(),
    ]);
    const tx: TransactionSerializable = {
      chainId: this.cfg.chain.id,
      type: "eip1559",
      to: call.to,
      value: call.value ?? 0n,
      data: call.data,
      nonce,
      gas: call.gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
    let signed: Hex;
    try {
      signed = await vault.signTransaction(fromAddress, tx, note);
    } catch (err) {
      throw new VaultRefusal((err as Error).message, err instanceof VaultError ? err.note : {});
    }
    const txHash = keccak256(signed);
    try {
      await this.primary.sendRawTransaction({ serializedTransaction: signed });
      return { txHash, fromAddress, nonce };
    } catch (err) {
      return { txHash, fromAddress, nonce, broadcastError: (err as Error).message };
    }
  }

  /** Where a sent withdrawal stands. Network errors throw; only "no receipt yet" is reported as unknown. */
  async withdrawalResult(txHash: string): Promise<WithdrawalResult> {
    const receipt = await this.receipt(this.primary, txHash);
    if (!receipt) return { state: "unknown" };
    const head = await this.primary.getBlockNumber();
    if (head - receipt.blockNumber < BigInt(this.cfg.confirmations)) return { state: "unconfirmed" };
    return { state: "done", feeActual: feePaid(receipt), success: receipt.status === "success" };
  }

  /**
   * True when the address has already used this transaction number on-chain but neither provider has a
   * receipt for our transaction: another transaction took its place, so ours can never land.
   */
  async wasDropped(txHash: string, fromAddress: string, nonce: number): Promise<boolean> {
    const mined = await this.primary.getTransactionCount({ address: fromAddress as Hex, blockTag: "latest" });
    if (mined <= nonce) return false;
    for (const client of [this.primary, this.secondary]) if (await this.receipt(client, txHash)) return false;
    return true;
  }

  private async receipt(client: PublicClient, txHash: string) {
    try {
      return await client.getTransactionReceipt({ hash: txHash as Hex });
    } catch (err) {
      if ((err as Error).name === "TransactionReceiptNotFoundError") return null;
      throw err;
    }
  }

  /**
   * True if the address has no code: a plain wallet. Withdrawals are 21,000-gas transfers (the vault's policy allows
   * nothing else), which revert at a contract or a smart account, including an EOA upgraded with EIP-7702.
   */
  async isPlainWallet(address: string): Promise<boolean> {
    const code = await this.primary.getCode({ address: address as Hex });
    return !code || code === "0x";
  }

  /** An ERC-20 balance (the vault's aWETH, for Earn). */
  async tokenBalance(token: Hex, owner: string): Promise<bigint> {
    return this.primary.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [owner as Hex] });
  }

  async allowance(token: Hex, owner: string, spender: Hex): Promise<bigint> {
    return this.primary.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner as Hex, spender] });
  }

  /** Aave's current yearly supply rate for WETH, in ray (1e27 = 100%). */
  async aaveSupplyRate(pool: Hex, weth: Hex): Promise<bigint> {
    const r = await this.primary.readContract({ address: pool, abi: POOL_ABI, functionName: "getReserveData", args: [weth] });
    return r.currentLiquidityRate;
  }

  async balanceOf(address: string): Promise<bigint> {
    return this.primary.getBalance({ address: address as Hex });
  }

  /** ETH for on-screen sentences: at most 6 decimals, trailing zeros dropped (fees are otherwise 15 digits long). */
  static fmt(wei: bigint): string {
    const micro = 10n ** 12n;
    const rounded = ((wei + micro / 2n) / micro) * micro;
    if (rounded === 0n && wei > 0n) return "less than 0.000001";
    return formatEther(rounded);
  }
}
