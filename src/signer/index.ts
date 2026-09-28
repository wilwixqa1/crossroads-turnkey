/**
 * The vault: who owns the deposit addresses and who signs withdrawals.
 *
 * Two implementations:
 *  - LocalVault: a stand-in for laptop development. Keys live in this process.
 *  - TurnkeyVault (Phase 1): addresses created by Turnkey, signatures produced by
 *    Turnkey under the signer key's policies. The app never sees a private key.
 *
 * The rest of the app only talks to this interface, so swapping them is one line.
 */
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import type { Hex, TransactionSerializable } from "viem";
import { evaluate, type ChainLimit } from "./policy.js";
import type { AaveMarket } from "../chains/aave.js";

/** What a vault reports about one call, for the page: the Turnkey activity and the policy decision. */
export interface VaultNote {
  activityId?: string;
  /** e.g. Allowed by "Vault signer: withdrawals on Sepolia, up to 0.05 ETH" (0.01 ETH, within the 0.05 ETH limit on Sepolia) */
  policy?: string;
  /** A contract call as Turnkey decodes it, e.g. "Aave depositETH, 0.02 ETH, on behalf of 0x…". Plain transfers have none. */
  call?: string;
}

/** A refusal from the vault, carrying the same note (the rejected activity and the policy that denied it). */
export class VaultError extends Error {
  constructor(message: string, readonly note: VaultNote = {}) {
    super(message);
  }
}

export interface Vault {
  /** Create a fresh deposit address (valid on every EVM chain). */
  newDepositAddress(note?: VaultNote): Promise<string>;
  /** Sign a fully specified transaction for the given vault address. Returns the signed, serialized transaction. */
  signTransaction(fromAddress: string, tx: TransactionSerializable, note?: VaultNote): Promise<Hex>;
  /** True if this vault holds the address and can sign for it. Used to re-link a user's earlier deposit address. */
  holds(address: string): Promise<boolean>;
  /** Short name used in "Under the hood" sentences, e.g. "Turnkey" or "Stand-in vault". */
  readonly label: string;
  /** Human description for the "Under the hood" panel. */
  describe(): string;
}

/** Stands in while the Turnkey vault is being set up, so the page can load and say so. It can do nothing. */
export class PendingVault implements Vault {
  readonly label = "Turnkey";
  constructor(public reason: string) {}
  async newDepositAddress(): Promise<string> {
    throw new Error("The Turnkey vault is still being set up. Try again in a minute.");
  }
  async signTransaction(): Promise<Hex> {
    throw new Error("The Turnkey vault is still being set up");
  }
  async holds(): Promise<boolean> {
    return false;
  }
  describe() {
    return `Turnkey vault not ready yet: ${this.reason}`;
  }
}

export class LocalVault implements Vault {
  readonly label = "Stand-in vault";
  private accounts = new Map<string, HDAccount>();
  private nextIndex: number;

  /**
   * @param rules The vault signer's rules (per-network limits, Aave), imitated here so the stand-in refuses what
   *              Turnkey would refuse. Omitted: the stand-in signs anything (unit tests only).
   */
  constructor(private mnemonic: string, existingAddresses: string[] = [], private rules?: { limits: ChainLimit[]; aave?: AaveMarket[] }) {
    // Re-derive any addresses the ledger already knows so restarts keep working.
    this.nextIndex = 0;
    // NEXT PERSON: addresses are re-derived in creation order from the mnemonic. Changing the mnemonic
    // with an existing STATE_PATH fails on purpose; use a fresh STATE_PATH instead.
    for (const addr of existingAddresses) {
      const acct = mnemonicToAccount(mnemonic, { addressIndex: this.nextIndex++ });
      if (acct.address.toLowerCase() !== addr.toLowerCase()) throw new Error(`Local vault mnemonic does not match ledger address ${addr}`);
      this.accounts.set(acct.address.toLowerCase(), acct);
    }
  }

  async newDepositAddress(): Promise<string> {
    const acct = mnemonicToAccount(this.mnemonic, { addressIndex: this.nextIndex++ });
    this.accounts.set(acct.address.toLowerCase(), acct);
    return acct.address;
  }

  async holds(address: string): Promise<boolean> {
    return this.accounts.has(address.toLowerCase());
  }

  async signTransaction(fromAddress: string, tx: TransactionSerializable, note?: VaultNote): Promise<Hex> {
    const acct = this.accounts.get(fromAddress.toLowerCase());
    if (!acct) throw new Error(`Local vault does not hold ${fromAddress}`);
    if (this.rules) {
      const v = evaluate(tx, fromAddress, this.rules.limits, this.rules.aave ?? []);
      const standIn = (name?: string) => (name ? `"${name}" (the stand-in imitating Turnkey's policy)` : "");
      if (!v.allowed) throw new VaultError(`Policy refused: ${v.reason}`, { policy: v.policy ? `Denied by ${standIn(v.policy)}` : "No policy allows it", call: v.call });
      if (note) {
        note.policy = `Allowed by ${standIn(v.policy)} (${v.reason})`;
        note.call = v.call;
      }
    }
    return acct.signTransaction(tx);
  }

  describe() {
    return "Local stand-in vault (keys in this process). Not the real thing.";
  }
}
