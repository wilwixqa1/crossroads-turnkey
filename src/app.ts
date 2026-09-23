/**
 * The Crossroads app: everything the ROFL enclave runs.
 *
 *   ledger   — who owns what (src/ledger)
 *   vault    — who holds the keys and signs (src/signer)
 *   chains   — deposit scanning and withdrawal sending (src/chains)
 *   storage  — save after every change (src/storage)
 *
 * Background loops:
 *   pollDeposits()     every few seconds, per chain
 *   processWithdrawals() sign+send pending ones, settle sent ones
 */
import { parseEther } from "viem";
import { Ledger, LedgerError, type Asset, type Account, type Withdrawal } from "./ledger/ledger.js";
import { verifyRequest, type SignedRequest } from "./ledger/requests.js";
import { CHAINS, chainFor } from "./chains/config.js";
import { EvmChain } from "./chains/evm.js";
import type { Vault } from "./signer/index.js";
import { loadState, saveState, type AppState } from "./storage/state.js";

/** Per-withdrawal cap enforced by the app. Turnkey's policy enforces the same cap independently. */
export const WITHDRAWAL_CAP = parseEther(process.env.WITHDRAWAL_CAP_ETH ?? "0.05");

export interface HoodEntry {
  at: number;
  account?: string;
  text: string;
  link?: string;
  ms?: number;
  source: "turnkey" | "chain" | "ledger";
}

export class App {
  ledger: Ledger;
  chains = new Map<Asset, EvmChain>();
  scanCursor: Record<string, bigint> = {};
  /** "Under the hood" log shown in the UI. */
  hood: HoodEntry[] = [];
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();

  constructor(readonly vault: Vault, readonly statePath: string) {
    const saved = loadState(statePath);
    this.ledger = new Ledger(saved?.ledger);
    for (const [k, v] of Object.entries(saved?.scanCursor ?? {})) this.scanCursor[k] = BigInt(v);
    for (const cfg of CHAINS) this.chains.set(cfg.asset, new EvmChain(cfg));
  }

  save() {
    const cursor: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.scanCursor)) cursor[k] = v.toString();
    const state: AppState = { ledger: this.ledger.state, scanCursor: cursor, version: 1 };
    saveState(this.statePath, state);
  }

  log(e: Omit<HoodEntry, "at">) {
    this.hood.push({ at: Date.now(), ...e });
    if (this.hood.length > 500) this.hood.splice(0, this.hood.length - 500);
  }

  // ---------- accounts ----------

  async signUp(id: string, name: string): Promise<Account> {
    const t0 = Date.now();
    const depositAddress = await this.vault.newDepositAddress();
    this.log({ source: "turnkey", account: id.toLowerCase(), text: `Vault created a deposit address for ${name}: ${depositAddress}`, ms: Date.now() - t0 });
    const acct = this.ledger.createAccount(id, name, depositAddress);
    this.save();
    return acct;
  }

  // ---------- signed requests ----------

  async handleRequest(req: SignedRequest): Promise<Record<string, unknown>> {
    await verifyRequest(req);
    const acct = this.ledger.getAccount(req.account);
    this.ledger.consumeSeq(acct.id, req.seq);
    const t0 = Date.now();
    try {
      const result = await this.apply(acct, req);
      this.log({ source: "ledger", account: acct.id, text: `${req.action} settled on the ledger`, ms: Date.now() - t0 });
      return result;
    } finally {
      this.save();
    }
  }

  private async apply(acct: Account, req: SignedRequest): Promise<Record<string, unknown>> {
    const p = req.params;
    const asset = p.asset as Asset;
    switch (req.action) {
      case "transfer": {
        this.ledger.transfer(acct.id, p.to, asset, BigInt(p.amount));
        return { ok: true };
      }
      case "swap": {
        const out = this.ledger.swap(acct.id, asset, p.assetOut as Asset, BigInt(p.amount), BigInt(p.minOut ?? "0"));
        return { ok: true, amountOut: out.toString() };
      }
      case "add_liquidity": {
        this.ledger.addLiquidity(acct.id, asset, BigInt(p.amount));
        return { ok: true };
      }
      case "withdraw": {
        const amount = BigInt(p.amount);
        // NEXT PERSON: the app cap is the first gate; Turnkey's policy is the second. bypassAppCap exists
        // only so the "Try to break it" button can reach Turnkey's refusal. Never set it from the normal UI path.
        if (amount > WITHDRAWAL_CAP) {
          // Deliberately let "Try to break it" through to Turnkey? No: the ledger refuses first unless the request says so.
          if (p.bypassAppCap !== "true") throw new LedgerError("Above the app's per-withdrawal cap", "CAP");
        }
        const chain = this.chains.get(asset)!;
        const fee = await chain.estimateWithdrawalFee();
        const w = this.ledger.requestWithdrawal(acct.id, asset, amount, fee, p.destination);
        this.log({ source: "ledger", account: acct.id, text: `Locked ${EvmChain.fmt(amount)} plus fee reserve for withdrawal ${w.id}` });
        return { ok: true, withdrawalId: w.id, feeReserved: fee.toString() };
      }
      default:
        throw new LedgerError(`Unknown action ${req.action}`, "BAD_ACTION");
    }
  }

  // ---------- deposit loop ----------

  async pollDeposits(asset: Asset) {
    const key = `deposits:${asset}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const chain = this.chains.get(asset)!;
      const head = await chain.confirmedHead();
      // NEXT PERSON: first run starts at the current tip, so deposits made before the app was running are
      // never seen. Fund addresses only after startup, or set scanCursor lower by hand in the state file.
      const from = this.scanCursor[asset] ?? head; // first run: start at the tip, do not replay history
      if (head <= from) return;
      // Cap catch-up so a long pause does not scan thousands of blocks at once.
      const to = head - from > 50n ? from + 50n : head;
      const watched = new Set(this.ledger.depositAddresses());
      const deposits = await chain.scanDeposits(from, to, watched);
      for (const d of deposits) {
        if (this.ledger.hasDeposit(asset, d.txHash)) continue;
        const acct = this.ledger.creditDeposit(asset, d.txHash, d.to, d.amount);
        this.log({ source: "chain", account: acct.id, text: `Deposit of ${EvmChain.fmt(d.amount)} on ${asset} confirmed by two providers and credited`, link: chain.cfg.explorerTx(d.txHash) });
      }
      this.scanCursor[asset] = to;
      this.save();
    } catch (err) {
      this.log({ source: "chain", text: `Deposit scan on ${asset} hit an error: ${(err as Error).message}` });
    } finally {
      this.busy.delete(key);
    }
  }

  // ---------- withdrawal loop ----------

  async processWithdrawals() {
    if (this.busy.has("withdrawals")) return;
    this.busy.add("withdrawals");
    try {
      for (const w of this.ledger.pendingWithdrawals()) await this.sendOne(w);
      for (const w of this.ledger.sentWithdrawals()) await this.settleOne(w);
    } finally {
      this.busy.delete("withdrawals");
    }
  }

  private async sendOne(w: Withdrawal) {
    const chain = this.chains.get(w.asset)!;
    const acct = this.ledger.getAccount(w.account);
    try {
      // Pick a vault address with enough funds: the user's own deposit address first, then any other.
      const need = w.amount + w.feeReserved;
      const candidates = [acct.depositAddress, ...this.ledger.depositAddresses().filter((a) => a !== acct.depositAddress)];
      let from: string | undefined;
      for (const addr of candidates) {
        if ((await chain.balanceOf(addr)) >= need) {
          from = addr;
          break;
        }
      }
      if (!from) throw new Error("No vault address holds enough on this chain (needs rebalancing)");
      const t0 = Date.now();
      const sent = await chain.sendWithdrawal(this.vault, from, w.destination, w.amount);
      this.ledger.markWithdrawalSent(w.id, sent.fromAddress, sent.txHash);
      this.log({ source: "turnkey", account: w.account, text: `Vault signed withdrawal ${w.id} from ${from} and it was broadcast`, ms: Date.now() - t0, link: chain.cfg.explorerTx(sent.txHash) });
    } catch (err) {
      const msg = (err as Error).message;
      this.ledger.failWithdrawal(w.id, msg);
      this.log({ source: "turnkey", account: w.account, text: `Withdrawal ${w.id} refused: ${msg}. Funds unlocked.` });
    } finally {
      this.save();
    }
  }

  private async settleOne(w: Withdrawal) {
    const chain = this.chains.get(w.asset)!;
    const res = await chain.withdrawalResult(w.txHash!);
    if (!res) return;
    if (res.success) {
      this.ledger.completeWithdrawal(w.id, res.feeActual);
      this.log({ source: "chain", account: w.account, text: `Withdrawal ${w.id} confirmed. Real fee ${EvmChain.fmt(res.feeActual)}, unused reserve refunded.`, link: chain.cfg.explorerTx(w.txHash!) });
    } else {
      this.ledger.failWithdrawal(w.id, "transaction reverted");
      this.log({ source: "chain", account: w.account, text: `Withdrawal ${w.id} reverted on-chain. Funds unlocked.` });
    }
    this.save();
  }

  // ---------- solvency ----------

  async solvency(): Promise<Record<Asset, { onChain: string; owed: string; ok: boolean }>> {
    const out = {} as Record<Asset, { onChain: string; owed: string; ok: boolean }>;
    for (const cfg of CHAINS) {
      const chain = this.chains.get(cfg.asset)!;
      let onChain = 0n;
      for (const addr of this.ledger.depositAddresses()) onChain += await chain.balanceOf(addr);
      const owed = this.ledger.totalLiabilities(cfg.asset);
      out[cfg.asset] = { onChain: onChain.toString(), owed: owed.toString(), ok: onChain >= owed };
    }
    return out;
  }

  // ---------- lifecycle ----------

  start() {
    for (const cfg of CHAINS) {
      const every = cfg.chain.id === chainFor("ETH_SEPOLIA").chain.id ? 6_000 : 3_000;
      this.timers.push(setInterval(() => void this.pollDeposits(cfg.asset), every));
    }
    this.timers.push(setInterval(() => void this.processWithdrawals(), 4_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }
}
