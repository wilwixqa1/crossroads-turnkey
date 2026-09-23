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
import type { Vault } from "../signer/index.js";

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
export class VaultRefusal extends Error {}

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

  /** Second provider must independently report a successful transfer of the same amount to the same address. */
  private async crossCheck(hash: Hex, to: string, amount: bigint): Promise<boolean> {
    try {
      const [receipt, tx] = await Promise.all([
        this.secondary.getTransactionReceipt({ hash }),
        this.secondary.getTransaction({ hash }),
      ]);
      return receipt.status === "success" && !!tx.to && tx.to.toLowerCase() === to && tx.value === amount;
    } catch {
      return false;
    }
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
  async sendWithdrawal(vault: Vault, fromAddress: string, to: string, amount: bigint): Promise<SentWithdrawal> {
    const [nonce, fees] = await Promise.all([
      this.primary.getTransactionCount({ address: fromAddress as Hex, blockTag: "pending" }),
      this.primary.estimateFeesPerGas(),
    ]);
    const tx: TransactionSerializable = {
      chainId: this.cfg.chain.id,
      type: "eip1559",
      to: to as Hex,
      value: amount,
      nonce,
      gas: 21_000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
    let signed: Hex;
    try {
      signed = await vault.signTransaction(fromAddress, tx);
    } catch (err) {
      throw new VaultRefusal((err as Error).message);
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
    return { state: "done", feeActual: receipt.gasUsed * receipt.effectiveGasPrice, success: receipt.status === "success" };
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
