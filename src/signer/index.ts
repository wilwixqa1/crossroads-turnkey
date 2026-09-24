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

export interface Vault {
  /** Create a fresh deposit address (valid on every EVM chain). */
  newDepositAddress(): Promise<string>;
  /** Sign a fully specified transaction for the given vault address. Returns the signed, serialized transaction. */
  signTransaction(fromAddress: string, tx: TransactionSerializable): Promise<Hex>;
  /** Short name used in "Under the hood" sentences, e.g. "Turnkey" or "Stand-in vault". */
  readonly label: string;
  /** Human description for the "Under the hood" panel. */
  describe(): string;
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

  async signTransaction(fromAddress: string, tx: TransactionSerializable): Promise<Hex> {
    const acct = this.accounts.get(fromAddress.toLowerCase());
    if (!acct) throw new Error(`Local vault does not hold ${fromAddress}`);
    if (this.cap !== undefined && (tx.value ?? 0n) > this.cap) {
      throw new Error(`Policy refused: ${formatEther(tx.value ?? 0n)} ETH is above the ${formatEther(this.cap)} ETH per-withdrawal cap (stand-in for Turnkey's policy)`);
    }
    return acct.signTransaction(tx);
  }

  describe() {
    return "Local stand-in vault (keys in this process). Not the real thing.";
  }
}
