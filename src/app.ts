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
import { encodeFunctionData, type Hex } from "viem";
import { Ledger, LedgerError, type Asset, type Account, type EarnOp, type Withdrawal } from "./ledger/ledger.js";
import { verifyRequest, type SignedRequest } from "./ledger/requests.js";
import { CHAINS, chainFor } from "./chains/config.js";
import { EvmChain, VaultRefusal } from "./chains/evm.js";
import { ERC20_ABI, GATEWAY_ABI, aaveMarket } from "./chains/aave.js";
import type { Vault, VaultNote } from "./signer/index.js";
import { loadState, saveState, type AppState } from "./storage/state.js";

/**
 * An account whose ledger was lost with an old machine: on its next sign-in it gets its earlier deposit address back
 * (the vault still holds it) and the listed deposits are credited again by their transactions (two providers, once).
 */
export interface RestoreEntry {
  account: string;
  depositAddress: string;
  deposits?: { asset: Asset; txHash: string }[];
}

export interface AppOptions {
  /** Only this account may add liquidity. Unset means anyone may (laptop development). */
  liquidityProvider?: string;
  restore?: RestoreEntry[];
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
  /** Which Turnkey key acted, when one did. */
  key?: "your wallet" | "vault signer" | "vault admin" | "sign-up key";
  /** The Turnkey activity, so the line can be matched in the dashboard. */
  activityId?: string;
  /** The Turnkey policy decision, by policy name. */
  policy?: string;
  /** A contract call as Turnkey read it, e.g. "Aave depositETH, 0.02 ETH, on behalf of 0x…". */
  call?: string;
  /** The user action this line belongs to: `req:<account>:<seq>` or `signin:<account>:<time>`. */
  ref?: string;
}

/** What the page tells the app about the signature it just got from the user's Turnkey wallet. Display only. */
export interface RequestTrace {
  activityId?: string;
  signMs?: number;
}

/** Why a withdrawal to a contract or smart account is refused before anything is signed. */
export function notPlainMessage(chainName: string): string {
  return `That address is a smart contract or smart account on ${chainName}. Crossroads withdrawals are plain ETH transfers, which cannot reach it. Use a plain wallet address.`;
}

const ACTION_NAMES: Record<SignedRequest["action"], string> = {
  transfer: "Transfer",
  swap: "Swap",
  withdraw: "Withdrawal request",
  add_liquidity: "Liquidity",
  earn_start: "Start earning",
  earn_stop: "Stop earning",
};

/** Gas the fee reserve for an Aave supply assumes. The real use is about 200,000; the unused part is refunded. */
const SUPPLY_GAS = 300_000n;
/** How much the vault lets Aave's gateway take back from one address at a time (one approval covers many withdrawals). */
const GATEWAY_ALLOWANCE = 10n ** 19n;

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
  /** The most recent request that used up its sequence number: the proof page's replay check sends it again. */
  lastRequest?: SignedRequest;
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

  async signUp(id: string, name: string, ref?: string): Promise<Account> {
    const t0 = Date.now();
    const restore = this.opts.restore?.find((r) => r.account.toLowerCase() === id.toLowerCase());
    const earlier = restore?.depositAddress.toLowerCase();
    let acct: Account;
    if (earlier && !this.ledger.findByDepositAddress(earlier) && (await this.vault.holds(earlier))) {
      acct = this.ledger.createAccount(id, name, earlier);
      this.log({ source: "ledger", account: acct.id, ref, text: `Crossroads gave ${name} back their earlier deposit address, ${earlier}. The vault kept it when the app moved to a new machine.` });
      for (const d of restore!.deposits ?? []) this.claims.push({ ...d, account: acct.id });
    } else {
      const note: VaultNote = {};
      const depositAddress = await this.vault.newDepositAddress(note);
      const turnkey = this.vault.label === "Turnkey";
      this.log({ source: "turnkey", account: id.toLowerCase(), key: turnkey ? "vault admin" : undefined, activityId: note.activityId, ref, text: `${this.vault.label} created a deposit address for ${name} in the vault: ${depositAddress}. It works on every chain the app supports.`, ms: Date.now() - t0 });
      acct = this.ledger.createAccount(id, name, depositAddress);
    }
    this.save();
    if (this.claims.length) void this.retryClaims();
    return acct;
  }

  /** Deposits to credit again after a restore. Retried on every deposit poll until credited or found not to be one. */
  claims: { asset: Asset; txHash: string; account: string }[] = [];

  async retryClaims() {
    for (const c of [...this.claims]) {
      try {
        const res = await this.claimDeposit(c.asset, c.txHash);
        this.claims = this.claims.filter((x) => x !== c);
        if (!res.credited) this.log({ source: "ledger", account: c.account, text: `Earlier deposit ${c.txHash} was not credited again: ${res.reason}.` });
      } catch (err) {
        console.warn(`restore claim ${c.txHash}: ${(err as Error).message}`); // network trouble: try again next poll
      }
    }
  }

  // ---------- signed requests ----------

  async handleRequest(req: SignedRequest, trace?: RequestTrace): Promise<Record<string, unknown>> {
    await verifyRequest(req);
    const acct = this.ledger.getAccount(req.account);
    this.ledger.consumeSeq(acct.id, req.seq);
    this.lastRequest = req;
    const ref = `req:${acct.id}:${req.seq}`;
    if (trace?.activityId) {
      this.log({ source: "wallet", account: acct.id, key: "your wallet", activityId: trace.activityId, ms: trace.signMs, ref, text: `Your Turnkey wallet signed request #${req.seq} (${ACTION_NAMES[req.action].toLowerCase()}) through this browser's session. No pop-up, no gas.` });
    }
    this.log({ source: "ledger", account: acct.id, ref, text: `Crossroads checked that signature against your account and used up request number ${req.seq}, so it can never be replayed.` });
    const firstEvent = this.ledger.state.nextEventId;
    const t0 = performance.now();
    try {
      const result = await this.apply(acct, req, ref);
      const settledMs = Math.round((performance.now() - t0) * 100) / 100;
      // Stamp the settlement time on the events this request produced, so the activity feed can show it.
      for (const e of this.ledger.state.events) if (e.id >= firstEvent) e.detail.settledMs = settledMs;
      if (!["withdraw", "earn_start", "earn_stop"].includes(req.action)) this.log({ source: "ledger", account: acct.id, ref, text: `${ACTION_NAMES[req.action]} settled on the ledger. No blockchain involved.`, ms: settledMs });
      return { ...result, settledMs, ref };
    } finally {
      this.save();
    }
  }

  private async apply(acct: Account, req: SignedRequest, ref: string): Promise<Record<string, unknown>> {
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
        if (!(await chain.isPlainWallet(p.destination))) throw new LedgerError(notPlainMessage(chain.cfg.chain.name), "NOT_PLAIN");
        const fee = await chain.estimateWithdrawalFee();
        const w = this.ledger.requestWithdrawal(acct.id, asset, amount, fee, p.destination);
        w.ref = ref;
        this.log({ source: "ledger", account: acct.id, ref, text: `Locked ${EvmChain.fmt(amount)} ETH plus a ${EvmChain.fmt(fee)} ETH fee reserve for withdrawal #${w.id}. Nothing is signed until the funds are locked.` });
        return { ok: true, withdrawalId: w.id, feeReserved: fee.toString() };
      }
      case "earn_start": {
        if (!aaveMarket(asset)) throw new LedgerError("Earning is not available for that asset", "NO_EARN");
        const amount = BigInt(p.amount);
        const fee = await this.chains.get(asset)!.feeFor(SUPPLY_GAS);
        const op = this.ledger.requestSupply(acct.id, asset, amount, fee, ref);
        this.log({ source: "ledger", account: acct.id, ref, text: `Locked ${EvmChain.fmt(amount)} ETH plus a ${EvmChain.fmt(fee)} ETH fee reserve to supply to Aave. Nothing is signed until the funds are locked.` });
        return { ok: true, earnId: op.id };
      }
      case "earn_stop": {
        if (!aaveMarket(asset)) throw new LedgerError("Earning is not available for that asset", "NO_EARN");
        const supplied = await this.refreshEarn(asset);
        const op = this.ledger.requestRedeem(acct.id, asset, p.amount === "all" ? "all" : BigInt(p.amount), supplied, ref);
        this.log({ source: "ledger", account: acct.id, ref, text: `Set aside your share of the pool worth ${EvmChain.fmt(op.amount)} ETH to take back from Aave. It stays in the pool until Aave returns it.` });
        return { ok: true, earnId: op.id };
      }
      default:
        throw new LedgerError(`Unknown action ${req.action}`, "BAD_ACTION");
    }
  }

  // ---------- earn (pooled Aave supply) ----------

  /** The vault's Aave position per asset, refreshed from the chain: total supplied, per address, and the rate. */
  earnInfo: Partial<Record<Asset, { supplied: bigint; byAddress: Record<string, bigint>; rate: bigint; at: number }>> = {};

  /** Read the vault's aWETH across all its addresses (the pool's value) and Aave's current rate. */
  async refreshEarn(asset: Asset): Promise<bigint> {
    const market = aaveMarket(asset);
    if (!market) return 0n;
    const chain = this.chains.get(asset)!;
    const byAddress: Record<string, bigint> = {};
    let supplied = 0n;
    for (const addr of this.ledger.depositAddresses()) {
      const b = await chain.tokenBalance(market.aWeth, addr);
      if (b > 0n) byAddress[addr] = b;
      supplied += b;
    }
    const prev = this.earnInfo[asset];
    const rate = prev && Date.now() - prev.at < 60_000 ? prev.rate : await chain.aaveSupplyRate(market.pool, market.weth);
    this.earnInfo[asset] = { supplied, byAddress, rate, at: prev && Date.now() - prev.at < 60_000 ? prev.at : Date.now() };
    return supplied;
  }

  private async processEarn() {
    for (const op of Object.values(this.ledger.earn.ops).filter((o) => o.status === "pending")) await this.sendEarn(op);
    for (const op of Object.values(this.ledger.earn.ops).filter((o) => o.status === "approving" || o.status === "sent")) {
      try {
        await this.settleEarn(op);
      } catch (err) {
        console.warn(`settle earn ${op.id}: ${(err as Error).message}`); // network trouble: try again next round
      }
    }
  }

  private async sendEarn(op: EarnOp) {
    const chain = this.chains.get(op.asset)!;
    const market = aaveMarket(op.asset)!;
    const acct = this.ledger.getAccount(op.account);
    const turnkey = this.vault.label === "Turnkey";
    const signer = turnkey ? ("vault signer" as const) : undefined;
    const t0 = performance.now();
    try {
      const note: VaultNote = {};
      if (op.kind === "supply") {
        const need = op.amount + op.feeReserved;
        const candidates = [acct.depositAddress, ...this.ledger.depositAddresses().filter((a) => a !== acct.depositAddress)];
        let from: string | undefined;
        for (const addr of candidates) {
          if ((await chain.balanceOf(addr)) >= need) {
            from = addr;
            break;
          }
        }
        if (!from) {
          this.ledger.failEarn(op.id, "No single vault address holds enough on this chain");
          this.log({ source: "ledger", account: op.account, ref: op.ref, text: `Not supplied: no single vault address holds enough on ${chain.cfg.chain.name}. Funds unlocked.` });
          return;
        }
        const data = encodeFunctionData({ abi: GATEWAY_ABI, functionName: "depositETH", args: [market.pool, from as Hex, 0] });
        const gas = await chain.estimateCallGas(from, { to: market.gateway, data, value: op.amount });
        const sent = await chain.sendFromVault(this.vault, from, { to: market.gateway, data, value: op.amount, gas }, note);
        this.ledger.markEarnSent(op.id, { txHash: sent.txHash, fromAddress: from, nonce: sent.nonce });
        this.log({ source: "turnkey", account: op.account, ref: op.ref, key: signer, activityId: note.activityId, policy: note.policy, call: note.call, ms: Math.round(performance.now() - t0), text: `The vault's signer asked ${this.vault.label} to supply ${EvmChain.fmt(op.amount)} ETH to Aave from vault address ${from}. ${this.vault.label} read the call, checked its policies and signed.` });
        this.log({ source: "chain", account: op.account, ref: op.ref, text: `Broadcast the Aave supply to ${chain.cfg.chain.name}. Waiting for it to confirm.`, link: chain.cfg.explorerTx(sent.txHash) });
        return;
      }
      // Redeem: from the address the approval went through, or one holding enough aWETH and enough ETH for gas.
      await this.refreshEarn(op.asset);
      const held = this.earnInfo[op.asset]?.byAddress ?? {};
      let from = op.fromAddress;
      if (!from) {
        for (const [addr, a] of Object.entries(held)) {
          if (a >= op.amount && (await chain.balanceOf(addr)) >= (await chain.feeFor(500_000n))) {
            from = addr;
            break;
          }
        }
      }
      if (!from) {
        this.ledger.failEarn(op.id, "No single vault address holds enough on Aave, with gas");
        this.log({ source: "ledger", account: op.account, ref: op.ref, text: `Not taken back: no single vault address holds that much on Aave plus gas. Your share is back in the pool.` });
        return;
      }
      if (held[from] !== undefined && held[from] < op.amount) op.amount = held[from]; // Aave's rounding: at most a few wei
      if ((await chain.allowance(market.aWeth, from, market.gateway)) < op.amount) {
        const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [market.gateway, GATEWAY_ALLOWANCE] });
        const gas = await chain.estimateCallGas(from, { to: market.aWeth, data });
        const sent = await chain.sendFromVault(this.vault, from, { to: market.aWeth, data, gas }, note);
        this.ledger.markEarnSent(op.id, { approveTxHash: sent.txHash, fromAddress: from, nonce: sent.nonce });
        this.log({ source: "turnkey", account: op.account, ref: op.ref, key: signer, activityId: note.activityId, policy: note.policy, call: note.call, ms: Math.round(performance.now() - t0), text: `First, the vault's signer asked ${this.vault.label} to let Aave's gateway take back aWETH from vault address ${from}. ${this.vault.label} read the call, checked its policies and signed.` });
        this.log({ source: "chain", account: op.account, ref: op.ref, text: `Broadcast the approval to ${chain.cfg.chain.name}. The withdrawal from Aave follows once it confirms.`, link: chain.cfg.explorerTx(sent.txHash) });
        return;
      }
      const data = encodeFunctionData({ abi: GATEWAY_ABI, functionName: "withdrawETH", args: [market.pool, op.amount, from as Hex] });
      const gas = await chain.estimateCallGas(from, { to: market.gateway, data });
      const sent = await chain.sendFromVault(this.vault, from, { to: market.gateway, data, gas }, note);
      this.ledger.markEarnSent(op.id, { txHash: sent.txHash, fromAddress: from, nonce: sent.nonce });
      this.log({ source: "turnkey", account: op.account, ref: op.ref, key: signer, activityId: note.activityId, policy: note.policy, call: note.call, ms: Math.round(performance.now() - t0), text: `The vault's signer asked ${this.vault.label} to withdraw ${EvmChain.fmt(op.amount)} ETH from Aave back to vault address ${from}. ${this.vault.label} read the call, checked its policies and signed.` });
      this.log({ source: "chain", account: op.account, ref: op.ref, text: `Broadcast the Aave withdrawal to ${chain.cfg.chain.name}. Waiting for it to confirm.`, link: chain.cfg.explorerTx(sent.txHash) });
    } catch (err) {
      // Nothing was signed on any path that reaches here, so undoing the request cannot double-spend.
      const msg = (err as Error).message.split("\n")[0];
      this.ledger.failEarn(op.id, msg);
      if (err instanceof VaultRefusal) {
        this.log({ source: "turnkey", account: op.account, ref: op.ref, key: signer, activityId: err.note.activityId, policy: err.note.policy, call: err.note.call, text: `${this.vault.label} refused to sign: ${msg}. Nothing was signed.`, ms: Math.round(performance.now() - t0) });
      } else {
        this.log({ source: "chain", account: op.account, ref: op.ref, text: `Not sent: ${msg}. Everything is back where it was.` });
      }
    } finally {
      this.save();
    }
  }

  private async settleEarn(op: EarnOp) {
    const chain = this.chains.get(op.asset)!;
    const hash = op.status === "approving" ? op.approveTxHash! : op.txHash!;
    const res = await chain.withdrawalResult(hash);
    if (res.state === "unconfirmed") return;
    if (res.state === "unknown") {
      if (op.nonce === undefined || Date.now() - op.updatedAt < App.DROP_GRACE_MS) return;
      if (!(await chain.wasDropped(hash, op.fromAddress!, op.nonce))) return;
      this.ledger.failEarn(op.id, "transaction dropped");
      this.log({ source: "chain", account: op.account, ref: op.ref, text: `The transaction never reached the chain and another used its slot. Everything is back where it was.` });
      this.save();
      return;
    }
    if (!res.success) {
      this.ledger.failEarn(op.id, "transaction reverted", res.feeActual);
      this.log({ source: "chain", account: op.account, ref: op.ref, text: `It reverted on-chain. Everything is back, less the ${EvmChain.fmt(res.feeActual)} ETH network fee it used.`, link: chain.cfg.explorerTx(hash) });
    } else if (op.status === "approving") {
      this.ledger.approvalConfirmed(op.id, res.feeActual);
      this.log({ source: "chain", account: op.account, ref: op.ref, text: `Approval confirmed. Sending the withdrawal from Aave next.`, link: chain.cfg.explorerTx(hash) });
    } else {
      const supplied = await this.refreshEarn(op.asset);
      this.ledger.completeEarn(op.id, res.feeActual, supplied);
      const what = op.kind === "supply" ? `Aave confirmed the supply. ${EvmChain.fmt(op.amount)} ETH is now earning in the vault's pooled position.` : `Aave returned ${EvmChain.fmt(op.amount)} ETH to the vault. It is in your available balance, less ${EvmChain.fmt(op.feePaid)} ETH in network fees.`;
      this.log({ source: "chain", account: op.account, ref: op.ref, text: what, link: chain.cfg.explorerTx(hash) });
    }
    this.save();
  }

  // ---------- deposit loop ----------

  async pollDeposits(asset: Asset) {
    const key = `deposits:${asset}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      if (this.claims.some((c) => c.asset === asset)) await this.retryClaims();
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

  /**
   * Credit one deposit by its transaction hash, when a scan missed it. Safe for anyone to ask: it credits only a real,
   * confirmed transfer into a vault deposit address (checked by two providers), to that address's owner, and only once.
   */
  async claimDeposit(asset: Asset, txHash: string): Promise<{ credited: boolean; account?: string; amount?: string; reason?: string }> {
    const chain = this.chains.get(asset);
    if (!chain) throw new LedgerError(`Unknown asset ${asset}`, "BAD_ASSET");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new LedgerError("txHash must be a transaction hash", "BAD_TX");
    if (this.ledger.hasDeposit(asset, txHash)) return { credited: false, reason: "already credited" };
    const d = await chain.depositByHash(txHash as `0x${string}`, new Set(this.ledger.depositAddresses()));
    if (!d) return { credited: false, reason: "not a confirmed transfer into a Crossroads deposit address" };
    if (this.ledger.hasDeposit(asset, d.txHash)) return { credited: false, reason: "already credited" };
    const acct = this.ledger.creditDeposit(asset, d.txHash, d.to, d.amount);
    this.incoming.delete(`${asset}:${d.txHash.toLowerCase()}`);
    this.save();
    this.log({ source: "chain", account: acct.id, text: `Deposit of ${EvmChain.fmt(d.amount)} ETH on ${chain.cfg.chain.name} confirmed by two providers and credited (claimed by its transaction)`, link: chain.cfg.explorerTx(d.txHash) });
    return { credited: true, account: acct.id, amount: d.amount.toString() };
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
      // Same loop as withdrawals, never alongside it: both take transaction numbers from the same vault addresses.
      await this.processEarn();
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
        this.log({ source: "ledger", account: w.account, ref: w.ref, text: `Withdrawal #${w.id} not sent: no single vault address holds enough on ${chainName} (needs rebalancing). Funds unlocked.` });
        return;
      }
      const note: VaultNote = {};
      const signer = this.vault.label === "Turnkey" ? ("vault signer" as const) : undefined;
      const sent = await chain.sendWithdrawal(this.vault, from, w.destination, w.amount, note);
      const ms = Math.round(performance.now() - t0);
      this.ledger.markWithdrawalSent(w.id, sent.fromAddress, sent.txHash, sent.nonce);
      if (sent.broadcastError) {
        this.log({ source: "chain", account: w.account, ref: w.ref, key: signer, activityId: note.activityId, text: `${this.vault.label} signed withdrawal #${w.id}, but ${chainName} reported an error on broadcast (${sent.broadcastError}). Funds stay locked until it confirms or is dropped.`, link: chain.cfg.explorerTx(sent.txHash) });
      } else {
        this.log({ source: "turnkey", account: w.account, ref: w.ref, key: signer, activityId: note.activityId, policy: note.policy, text: `The vault's signer asked ${this.vault.label} to sign withdrawal #${w.id} from vault address ${from}. ${this.vault.label} checked its policies and signed.`, ms });
        this.log({ source: "chain", account: w.account, ref: w.ref, text: `Broadcast withdrawal #${w.id} to ${chainName}. Waiting for it to confirm.`, link: chain.cfg.explorerTx(sent.txHash) });
      }
    } catch (err) {
      // Nothing was signed on any path that reaches here, so unlocking cannot double-spend.
      const msg = (err as Error).message;
      this.ledger.failWithdrawal(w.id, msg);
      if (err instanceof VaultRefusal) {
        this.log({ source: "turnkey", account: w.account, ref: w.ref, key: this.vault.label === "Turnkey" ? "vault signer" : undefined, activityId: err.note.activityId, policy: err.note.policy, text: `${this.vault.label} refused to sign withdrawal #${w.id}: ${msg}. Nothing was signed.`, ms: Math.round(performance.now() - t0) });
        this.log({ source: "ledger", account: w.account, ref: w.ref, text: `Crossroads unlocked the funds for withdrawal #${w.id}. Your balance is back.` });
      } else {
        this.log({ source: "chain", account: w.account, ref: w.ref, text: `Withdrawal #${w.id} not sent: ${msg}. Funds unlocked.` });
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
      this.log({ source: "chain", account: w.account, ref: w.ref, text: `Withdrawal #${w.id} never reached the chain and another transaction used its slot, so it can no longer land. Funds unlocked.` });
      this.save();
      return;
    }
    if (res.success) {
      this.ledger.completeWithdrawal(w.id, res.feeActual);
      this.log({ source: "chain", account: w.account, ref: w.ref, text: `Withdrawal #${w.id} confirmed on-chain. Real fee ${EvmChain.fmt(res.feeActual)} ETH, unused reserve refunded.`, link: chain.cfg.explorerTx(w.txHash!) });
    } else {
      // A reverted transaction still paid its network fee, so the user bears it, as for a completed withdrawal.
      this.ledger.failWithdrawal(w.id, "transaction reverted", res.feeActual);
      this.log({ source: "chain", account: w.account, ref: w.ref, text: `Withdrawal #${w.id} reverted on-chain. Funds unlocked, less the ${EvmChain.fmt(res.feeActual)} ETH network fee it used.`, link: chain.cfg.explorerTx(w.txHash!) });
    }
    this.save();
  }

  // ---------- solvency ----------

  /**
   * On-chain holdings against what the ledger owes. Funds supplied to Aave count on both sides: the vault's aWETH is
   * held, and every earning balance is owed (together they are exactly the aWETH, by how shares are priced).
   */
  async solvency(): Promise<Record<Asset, { onChain: string; owed: string; ok: boolean; earning: string }>> {
    const out = {} as Record<Asset, { onChain: string; owed: string; ok: boolean; earning: string }>;
    for (const cfg of CHAINS) {
      const chain = this.chains.get(cfg.asset)!;
      let eth = 0n;
      for (const addr of this.ledger.depositAddresses()) eth += await chain.balanceOf(addr);
      const earning = aaveMarket(cfg.asset) ? await this.refreshEarn(cfg.asset) : 0n;
      const onChain = eth + earning;
      const owed = this.ledger.totalLiabilities(cfg.asset) + (this.ledger.totalShares(cfg.asset) > 0n ? earning : 0n);
      out[cfg.asset] = { onChain: onChain.toString(), owed: owed.toString(), ok: onChain >= owed, earning: earning.toString() };
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
    // Keep the Earning column current: the vault's aWETH grows every block.
    for (const cfg of CHAINS) if (aaveMarket(cfg.asset)) this.timers.push(setInterval(() => void this.refreshEarn(cfg.asset).catch(() => undefined), 5_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }
}
