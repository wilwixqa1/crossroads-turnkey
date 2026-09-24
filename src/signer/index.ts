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
import { formatEther, type Hex, type TransactionSerializable } from "viem";

/** What a vault reports about one call, for the page: the Turnkey activity and the policy decision. */
export interface VaultNote {
  activityId?: string;
  /** e.g. Allowed by "Vault signer: withdrawals on Sepolia and Base Sepolia" (0.01 ETH, within the 0.05 ETH cap) */
  policy?: string;
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
  describe() {
    return `Turnkey vault not ready yet: ${this.reason}`;
  }
}

export class LocalVault implements Vault {
  readonly label = "Stand-in vault";
  private accounts = new Map<string, HDAccount>();
  private nextIndex: number;

  /**
   * @param cap Per-transaction limit the stand-in enforces, imitating the Turnkey signer policy, so an
   *            over-limit withdrawal is refused on a laptop the same way Turnkey refuses it.
   */
  constructor(private mnemonic: string, existingAddresses: string[] = [], private cap?: bigint) {
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

  async signTransaction(fromAddress: string, tx: TransactionSerializable, note?: VaultNote): Promise<Hex> {
    const acct = this.accounts.get(fromAddress.toLowerCase());
    if (!acct) throw new Error(`Local vault does not hold ${fromAddress}`);
    if (this.cap !== undefined && (tx.value ?? 0n) > this.cap) {
      throw new VaultError(`Policy refused: ${formatEther(tx.value ?? 0n)} ETH is above the ${formatEther(this.cap)} ETH per-withdrawal cap (stand-in for Turnkey's policy)`, {
        policy: `Denied by the stand-in's ${formatEther(this.cap)} ETH cap`,
      });
    }
    if (note && this.cap !== undefined) note.policy = `Allowed by the stand-in's ${formatEther(this.cap)} ETH cap`;
    return acct.signTransaction(tx);
  }

  describe() {
    return "Local stand-in vault (keys in this process). Not the real thing.";
  }
}
