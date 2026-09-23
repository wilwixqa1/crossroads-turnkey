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
import { createPublicClient, http, formatEther, type PublicClient, type Hex, type TransactionSerializable } from "viem";
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

  /** Highest block number old enough to be treated as confirmed. */
  async confirmedHead(): Promise<bigint> {
    const head = await this.primary.getBlockNumber();
    return head - BigInt(this.cfg.confirmations);
  }

  /**
   * Scan blocks (from, to] for ETH transfers into any watched address, and
   * cross-check each with the second provider.
   */
  async scanDeposits(fromBlockExclusive: bigint, toBlockInclusive: bigint, watched: Set<string>): Promise<FoundDeposit[]> {
    const found: FoundDeposit[] = [];
    if (watched.size === 0) return found;
    for (let n = fromBlockExclusive + 1n; n <= toBlockInclusive; n++) {
      const block = await this.primary.getBlock({ blockNumber: n, includeTransactions: true });
      for (const tx of block.transactions) {
        if (typeof tx === "string") continue;
        if (!tx.to || tx.value === 0n) continue;
        const to = tx.to.toLowerCase();
        if (!watched.has(to)) continue;
        const ok = await this.crossCheck(tx.hash, to, tx.value);
        if (!ok) continue;
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

  /** Build, sign (via the vault), and broadcast a withdrawal. */
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
    const signed = await vault.signTransaction(fromAddress, tx);
    const txHash = await this.primary.sendRawTransaction({ serializedTransaction: signed });
    return { txHash, fromAddress };
  }

  /** Returns the real fee once the transaction is mined and confirmed, or null if not yet. */
  async withdrawalResult(txHash: string): Promise<{ feeActual: bigint; success: boolean } | null> {
    try {
      const receipt = await this.primary.getTransactionReceipt({ hash: txHash as Hex });
      const head = await this.primary.getBlockNumber();
      if (head - receipt.blockNumber < BigInt(this.cfg.confirmations)) return null;
      return { feeActual: receipt.gasUsed * receipt.effectiveGasPrice, success: receipt.status === "success" };
    } catch {
      return null;
    }
  }

  async balanceOf(address: string): Promise<bigint> {
    return this.primary.getBalance({ address: address as Hex });
  }

  static fmt(wei: bigint): string {
    return formatEther(wei);
  }
}
