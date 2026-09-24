/**
 * The Crossroads app: everything the ROFL enclave runs.
 *
 *   ledger   — who owns what (src/ledger)
 *   vault    — who holds the keys and signs (src/signer)
 *   chains   — deposit scanning and withdrawal sending (src/chains)
 *   storage  — save after every change (src/storage)
 *
 * Background loops:
 *   pollDeposits()     every few seconds, per chain: heads-up at the tip, credit once confirmed
 *   processWithdrawals() sign+send pending ones, settle sent ones
 */
import { parseEther } from "viem";
import { Ledger, LedgerError, type Asset, type Account, type Withdrawal } from "./ledger/ledger.js";
import { verifyRequest, type SignedRequest } from "./ledger/requests.js";
import { CHAINS, chainFor } from "./chains/config.js";
import { EvmChain, VaultRefusal } from "./chains/evm.js";
import type { Vault } from "./signer/index.js";
import { loadState, saveState, type AppState } from "./storage/state.js";

/**
 * The vault's per-withdrawal limit. Only the vault enforces it (Turnkey's policy, or the stand-in imitating
 * it); the app has no limit of its own, so an over-limit request is locked, sent to the vault, and refused there.
 */
export const WITHDRAWAL_CAP = parseEther(process.env.WITHDRAWAL_CAP_ETH ?? "0.05");

export interface AppOptions {
  /** Only this account may add liquidity. Unset means anyone may (laptop development). */
  liquidityProvider?: string;
}

/** A deposit seen at the chain tip that is not yet confirmed. Shown on the page; never credited from here. */
export interface Incoming {
  asset: Asset;
  txHash: string;
  account: string;
  amount: bigint;
  blockNumber: bigint;
}

export interface HoodEntry {
  at: number;
  account?: string;
  text: string;
  link?: string;
  ms?: number;
  /** turnkey: the vault (Turnkey, or the stand-in). wallet: the user's own Turnkey wallet. */
  source: "turnkey" | "wallet" | "chain" | "ledger";
}

const ACTION_NAMES: Record<SignedRequest["action"], string> = {
  transfer: "Transfer",
  swap: "Swap",
  withdraw: "Withdrawal request",
  add_liquidity: "Liquidity",
};

export class App {
  ledger: Ledger;
  chains = new Map<Asset, EvmChain>();
  scanCursor: Record<string, bigint> = {};
  /** Newest block seen per chain, for counting confirmations on the page. */
  heads: Partial<Record<Asset, bigint>> = {};
  /** Heads-up scan position per chain. In memory only: the confirmed scan is what credits deposits. */
  private tipCursor: Partial<Record<Asset, bigint>> = {};
  incoming = new Map<string, Incoming>();
  /** How long a sent withdrawal with no receipt waits before the app checks whether it was dropped. */
  static DROP_GRACE_MS = 5 * 60_000;
  /** "Under the hood" log shown in the UI. */
  hood: HoodEntry[] = [];
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();

  constructor(public vault: Vault, readonly statePath: string, readonly opts: AppOptions = {}) {
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
    this.log({ source: "turnkey", account: id.toLowerCase(), text: `${this.vault.label} created a deposit address for ${name}: ${depositAddress}. It works on every chain the app supports.`, ms: Date.now() - t0 });
    const acct = this.ledger.createAccount(id, name, depositAddress);
    this.save();
    return acct;
  }

  // ---------- signed requests ----------

  async handleRequest(req: SignedRequest): Promise<Record<string, unknown>> {
    await verifyRequest(req);
    const acct = this.ledger.getAccount(req.account);
    this.ledger.consumeSeq(acct.id, req.seq);
    this.log({ source: "ledger", account: acct.id, text: `Checked your wallet's signature on request #${req.seq}. That number is now used and cannot be replayed.` });
    const firstEvent = this.ledger.state.nextEventId;
    const t0 = performance.now();
    try {
      const result = await this.apply(acct, req);
      const settledMs = Math.round((performance.now() - t0) * 100) / 100;
      // Stamp the settlement time on the events this request produced, so the activity feed can show it.
      for (const e of this.ledger.state.events) if (e.id >= firstEvent) e.detail.settledMs = settledMs;
      if (req.action !== "withdraw") this.log({ source: "ledger", account: acct.id, text: `${ACTION_NAMES[req.action]} settled on the ledger. No blockchain involved.`, ms: settledMs });
      return { ...result, settledMs };
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
        const lp = this.opts.liquidityProvider?.toLowerCase();
        if (lp && acct.id !== lp) throw new LedgerError("Only the liquidity provider can add to the pool", "NOT_LP");
        this.ledger.addLiquidity(acct.id, asset, BigInt(p.amount));
        return { ok: true };
      }
      case "withdraw": {
        const amount = BigInt(p.amount);
        // NEXT PERSON: no limit check here on purpose. The vault's policy is the only limit, so the demo's
        // over-limit refusal visibly comes from Turnkey. Do not add an app-side cap back.
        const chain = this.chains.get(asset)!;
        const fee = await chain.estimateWithdrawalFee();
        const w = this.ledger.requestWithdrawal(acct.id, asset, amount, fee, p.destination);
        this.log({ source: "ledger", account: acct.id, text: `Locked ${EvmChain.fmt(amount)} ETH plus a ${EvmChain.fmt(fee)} ETH fee reserve for withdrawal #${w.id}. Nothing is signed until the funds are locked.` });
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
      const latest = await chain.latestHead();
      this.heads[asset] = latest;
      const watched = new Set(this.ledger.depositAddresses());
      await this.watchTip(asset, chain, latest, watched);
      const head = latest - BigInt(chain.cfg.confirmations);
      // NEXT PERSON: first run starts at the current tip, so deposits made before the app was running are
      // never seen. Fund addresses only after startup, or set scanCursor lower by hand in the state file.
      const from = this.scanCursor[asset];
      if (from === undefined) {
        this.scanCursor[asset] = head; // first run: start at the tip, do not replay history
        this.save();
        return;
      }
      if (head <= from) return;
      // Cap catch-up so a long pause does not scan thousands of blocks at once.
      const to = head - from > 50n ? from + 50n : head;
      const deposits = await chain.scanDeposits(from, to, watched);
      for (const d of deposits) {
        if (this.ledger.hasDeposit(asset, d.txHash)) continue;
        const acct = this.ledger.creditDeposit(asset, d.txHash, d.to, d.amount);
        this.incoming.delete(`${asset}:${d.txHash.toLowerCase()}`);
        this.log({ source: "chain", account: acct.id, text: `Deposit of ${EvmChain.fmt(d.amount)} ETH on ${chain.cfg.chain.name} confirmed by two providers and credited`, link: chain.cfg.explorerTx(d.txHash) });
      }
      this.scanCursor[asset] = to;
      this.save();
    } catch (err) {
      this.log({ source: "chain", text: `Deposit scan on ${asset} hit an error: ${(err as Error).message}` });
    } finally {
      this.busy.delete(key);
    }
  }

  /** Heads-up only: note deposits at the chain tip so the page can count confirmations. Never credits. */
  private async watchTip(asset: Asset, chain: EvmChain, latest: bigint, watched: Set<string>) {
    const needed = BigInt(chain.cfg.confirmations);
    try {
      let from = this.tipCursor[asset] ?? latest;
      if (latest - from > 20n) from = latest - 20n;
      for (const d of await chain.scanDeposits(from, latest, watched, false)) {
        const k = `${asset}:${d.txHash.toLowerCase()}`;
        const acct = this.ledger.findByDepositAddress(d.to);
        if (!acct || this.incoming.has(k) || this.ledger.hasDeposit(asset, d.txHash)) continue;
        this.incoming.set(k, { asset, txHash: d.txHash, account: acct.id, amount: d.amount, blockNumber: d.blockNumber });
        this.log({ source: "chain", account: acct.id, text: `Deposit of ${EvmChain.fmt(d.amount)} ETH seen on ${chain.cfg.chain.name}. Waiting for ${needed} confirmations before crediting.`, link: chain.cfg.explorerTx(d.txHash) });
      }
      this.tipCursor[asset] = latest;
    } catch (err) {
      console.warn(`tip scan on ${asset}: ${(err as Error).message}`);
    }
    for (const [k, inc] of this.incoming) {
      if (inc.asset !== asset) continue;
      if (this.ledger.hasDeposit(asset, inc.txHash) || latest - inc.blockNumber > needed + 100n) this.incoming.delete(k);
    }
  }

  /** Deposits on their way to this account, with confirmations counted against each chain's requirement. */
  incomingFor(accountId: string) {
    const id = accountId.toLowerCase();
    return [...this.incoming.values()]
      .filter((i) => i.account === id)
      .map((i) => {
        const cfg = chainFor(i.asset);
        const needed = cfg.confirmations;
        const head = this.heads[i.asset] ?? i.blockNumber;
        const seen = Number(head - i.blockNumber);
        return { asset: i.asset, txHash: i.txHash, amount: i.amount, confirmations: Math.max(0, Math.min(seen, needed)), needed, link: cfg.explorerTx(i.txHash) };
      });
  }

  // ---------- withdrawal loop ----------

  async processWithdrawals() {
    if (this.busy.has("withdrawals")) return;
    this.busy.add("withdrawals");
    try {
      for (const w of this.ledger.pendingWithdrawals()) await this.sendOne(w);
      for (const w of this.ledger.sentWithdrawals()) {
        try {
          await this.settleOne(w);
        } catch (err) {
          console.warn(`settle ${w.id}: ${(err as Error).message}`); // network trouble: try again next round
        }
      }
    } finally {
      this.busy.delete("withdrawals");
    }
  }

  private async sendOne(w: Withdrawal) {
    const chain = this.chains.get(w.asset)!;
    const acct = this.ledger.getAccount(w.account);
    const chainName = chain.cfg.chain.name;
    const t0 = performance.now();
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
      // NEXT PERSON: this funds check runs before the vault is asked to sign, so an over-limit withdrawal only
      // reaches the vault's policy when one vault address really holds more than the amount plus fee on that chain.
      if (!from) {
        this.ledger.failWithdrawal(w.id, "No single vault address holds enough on this chain");
        this.log({ source: "ledger", account: w.account, text: `Withdrawal #${w.id} not sent: no single vault address holds enough on ${chainName} (needs rebalancing). Funds unlocked.` });
        return;
      }
      const sent = await chain.sendWithdrawal(this.vault, from, w.destination, w.amount);
      const ms = Math.round(performance.now() - t0);
      this.ledger.markWithdrawalSent(w.id, sent.fromAddress, sent.txHash, sent.nonce);
      if (sent.broadcastError) {
        this.log({ source: "chain", account: w.account, text: `${this.vault.label} signed withdrawal #${w.id}, but ${chainName} reported an error on broadcast (${sent.broadcastError}). Funds stay locked until it confirms or is dropped.`, link: chain.cfg.explorerTx(sent.txHash) });
      } else {
        this.log({ source: "turnkey", account: w.account, text: `${this.vault.label} checked its policy and signed withdrawal #${w.id} from ${from}. Broadcast to ${chainName}.`, ms, link: chain.cfg.explorerTx(sent.txHash) });
      }
    } catch (err) {
      // Nothing was signed on any path that reaches here, so unlocking cannot double-spend.
      const msg = (err as Error).message;
      this.ledger.failWithdrawal(w.id, msg);
      if (err instanceof VaultRefusal) {
        this.log({ source: "turnkey", account: w.account, text: `${this.vault.label} refused to sign withdrawal #${w.id}: ${msg}. Funds unlocked.`, ms: Math.round(performance.now() - t0) });
      } else {
        this.log({ source: "chain", account: w.account, text: `Withdrawal #${w.id} not sent: ${msg}. Funds unlocked.` });
      }
    } finally {
      this.save();
    }
  }

  private async settleOne(w: Withdrawal) {
    const chain = this.chains.get(w.asset)!;
    const res = await chain.withdrawalResult(w.txHash!);
    if (res.state === "unconfirmed") return;
    if (res.state === "unknown") {
      if (w.nonce === undefined || Date.now() - w.updatedAt < App.DROP_GRACE_MS) return;
      if (!(await chain.wasDropped(w.txHash!, w.fromAddress!, w.nonce))) return;
      this.ledger.failWithdrawal(w.id, "transaction dropped");
      this.log({ source: "chain", account: w.account, text: `Withdrawal #${w.id} never reached the chain and another transaction used its slot, so it can no longer land. Funds unlocked.` });
      this.save();
      return;
    }
    if (res.success) {
      this.ledger.completeWithdrawal(w.id, res.feeActual);
      this.log({ source: "chain", account: w.account, text: `Withdrawal #${w.id} confirmed. Real fee ${EvmChain.fmt(res.feeActual)} ETH, unused reserve refunded.`, link: chain.cfg.explorerTx(w.txHash!) });
    } else {
      this.ledger.failWithdrawal(w.id, "transaction reverted");
      this.log({ source: "chain", account: w.account, text: `Withdrawal #${w.id} reverted on-chain. Funds unlocked.` });
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
