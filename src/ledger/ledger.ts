/**
 * The Crossroads ledger.
 *
 * Off-chain bookkeeping for a pooled, encumbered vault. Mirrors the rules of the
 * Crossroads asset contract (deposit → credit once, lock before sign, confirm
 * withdrawal → settle fee) but runs inside the ROFL app instead of on-chain.
 *
 * All amounts are bigint in the asset's smallest unit (wei).
 */

import { formatEther } from "viem";

const formatEth = (wei: bigint) => formatEther(wei);

export type Asset = "ETH_SEPOLIA" | "ETH_BASE_SEPOLIA";
export const ASSETS: Asset[] = ["ETH_SEPOLIA", "ETH_BASE_SEPOLIA"];

export interface Balance {
  available: bigint;
  pending: bigint;
}

export interface Account {
  /** Lowercase 0x address of the user's own wallet key (their identity). */
  id: string;
  name: string;
  /** Vault address (owned by Turnkey) this user deposits to. Valid on every EVM chain. */
  depositAddress: string;
  /** Next request sequence number this account must use. */
  nextSeq: number;
  balances: Record<Asset, Balance>;
  /** This account's share of the vault's pooled Aave supply, per asset (see Earn below). */
  earnShares?: Partial<Record<Asset, bigint>>;
  createdAt: number;
}

export type EarnStatus = "pending" | "approving" | "sent" | "complete" | "failed";

/**
 * Moving a user's funds into or out of the vault's pooled Aave supply.
 *
 * Supply: the amount (plus a fee reserve) is locked as pending, the vault supplies it to Aave from one of its
 * addresses, and on confirmation the user gets shares of the pool. Redeem: the user's shares are set aside, the vault
 * withdraws that much ETH from Aave, and on confirmation the user's available balance gets it, less the network fees.
 */
export interface EarnOp {
  id: string;
  account: string;
  asset: Asset;
  kind: "supply" | "redeem";
  amount: bigint;
  /** Supply: shares minted on completion. Redeem: shares set aside at request, burned on completion. */
  shares: bigint;
  /** Supply only: network fee reserve locked with the amount. */
  feeReserved: bigint;
  /** Network fees actually paid so far (approve + withdraw for a redeem). */
  feePaid: bigint;
  status: EarnStatus;
  fromAddress?: string;
  txHash?: string;
  approveTxHash?: string;
  nonce?: number;
  ref?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EarnState {
  /** Total shares outstanding per asset. Their value is the vault's aWETH across all its addresses. */
  shares: Partial<Record<Asset, bigint>>;
  ops: Record<string, EarnOp>;
}

export type WithdrawalStatus = "pending" | "sent" | "complete" | "failed";

export interface Withdrawal {
  id: string;
  account: string;
  asset: Asset;
  amount: bigint;
  /** Fee reserved at request time. Reconciled against the real fee on completion. */
  feeReserved: bigint;
  feeActual?: bigint;
  destination: string;
  status: WithdrawalStatus;
  fromAddress?: string;
  txHash?: string;
  /** Transaction number used on the vault address; lets the app tell a dropped transaction from a slow one. */
  nonce?: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
  /** The request that made it (account and sequence number), so the page can follow the whole withdrawal as one action. */
  ref?: string;
}

export interface Pool {
  reserves: Record<Asset, bigint>;
}

export interface LedgerEvent {
  id: number;
  at: number;
  account?: string;
  kind:
    | "account_created"
    | "deposit"
    | "transfer"
    | "swap"
    | "add_liquidity"
    | "withdraw_requested"
    | "withdraw_sent"
    | "withdraw_complete"
    | "withdraw_failed"
    | "earn_requested"
    | "earn_sent"
    | "earn_complete"
    | "earn_failed";
  settlement: "instant" | "onchain";
  detail: Record<string, string | number>;
}

export interface LedgerState {
  accounts: Record<string, Account>;
  /** key: `${asset}:${txHash.toLowerCase()}` → account credited */
  deposits: Record<string, string>;
  withdrawals: Record<string, Withdrawal>;
  pool: Pool;
  earn?: EarnState;
  events: LedgerEvent[];
  nextEventId: number;
}

export class LedgerError extends Error {
  constructor(message: string, public code: string = "LEDGER_ERROR") {
    super(message);
  }
}

function emptyBalances(): Record<Asset, Balance> {
  const out = {} as Record<Asset, Balance>;
  for (const a of ASSETS) out[a] = { available: 0n, pending: 0n };
  return out;
}

function assertAsset(asset: string): asserts asset is Asset {
  if (!ASSETS.includes(asset as Asset)) throw new LedgerError(`Unknown asset ${asset}`, "BAD_ASSET");
}

function assertPositive(amount: bigint, what = "amount") {
  if (amount <= 0n) throw new LedgerError(`${what} must be positive`, "BAD_AMOUNT");
}

export class Ledger {
  state: LedgerState;

  constructor(state?: LedgerState) {
    this.state = state ?? {
      accounts: {},
      deposits: {},
      withdrawals: {},
      pool: { reserves: { ETH_SEPOLIA: 0n, ETH_BASE_SEPOLIA: 0n } },
      events: [],
      nextEventId: 1,
    };
  }

  // ---------- accounts ----------

  createAccount(id: string, name: string, depositAddress: string): Account {
    const key = id.toLowerCase();
    if (this.state.accounts[key]) throw new LedgerError("Account already exists", "EXISTS");
    const acct: Account = {
      id: key,
      name,
      depositAddress: depositAddress.toLowerCase(),
      nextSeq: 1,
      balances: emptyBalances(),
      createdAt: Date.now(),
    };
    this.state.accounts[key] = acct;
    this.emit({ kind: "account_created", account: key, settlement: "instant", detail: { name, depositAddress: acct.depositAddress } });
    return acct;
  }

  getAccount(id: string): Account {
    const acct = this.state.accounts[id.toLowerCase()];
    if (!acct) throw new LedgerError("Unknown account", "NO_ACCOUNT");
    return acct;
  }

  findByDepositAddress(addr: string): Account | undefined {
    const a = addr.toLowerCase();
    return Object.values(this.state.accounts).find((x) => x.depositAddress === a);
  }

  /**
   * Who a Send goes to: an account ID, or a Crossroads deposit address (credited to its owner on the ledger, the way
   * an exchange handles a transfer between two of its own users). Undefined if it is neither.
   */
  findRecipient(idOrDepositAddress: string): Account | undefined {
    const q = idOrDepositAddress.trim().toLowerCase();
    return this.state.accounts[q] ?? this.findByDepositAddress(q);
  }

  /** Every vault deposit address the app must watch. */
  depositAddresses(): string[] {
    return Object.values(this.state.accounts).map((a) => a.depositAddress);
  }

  /**
   * Replay protection. A request must carry exactly the account's next sequence
   * number; on success the number advances so the same signed request can never
   * be applied twice.
   */
  // NEXT PERSON: consumeSeq runs before the action is applied, so a request that fails validation still
  // burns its number. Clients must re-fetch nextSeq after any error rather than retry the same seq.
  consumeSeq(accountId: string, seq: number) {
    const acct = this.getAccount(accountId);
    if (seq !== acct.nextSeq) {
      throw new LedgerError(`Bad sequence number: expected ${acct.nextSeq}, got ${seq}`, "BAD_SEQ");
    }
    acct.nextSeq += 1;
  }

  // ---------- deposits ----------

  /** Credit a confirmed on-chain deposit exactly once. */
  creditDeposit(asset: Asset, txHash: string, toAddress: string, amount: bigint): Account {
    assertAsset(asset);
    assertPositive(amount);
    const key = `${asset}:${txHash.toLowerCase()}`;
    if (this.state.deposits[key]) throw new LedgerError("Deposit already credited", "DUP_DEPOSIT");
    const acct = this.findByDepositAddress(toAddress);
    if (!acct) throw new LedgerError("Deposit to unknown address", "NO_ACCOUNT");
    acct.balances[asset].available += amount;
    this.state.deposits[key] = acct.id;
    this.emit({ kind: "deposit", account: acct.id, settlement: "onchain", detail: { asset, amount: amount.toString(), txHash } });
    return acct;
  }

  hasDeposit(asset: Asset, txHash: string): boolean {
    return Boolean(this.state.deposits[`${asset}:${txHash.toLowerCase()}`]);
  }

  // ---------- internal moves (instant) ----------

  transfer(from: string, to: string, asset: Asset, amount: bigint) {
    assertAsset(asset);
    assertPositive(amount);
    const a = this.getAccount(from);
    const b = this.findRecipient(to);
    if (!b) throw new LedgerError("That address isn't a Crossroads account. To send to your own wallet, use Withdraw.", "NOT_AN_ACCOUNT");
    if (a.id === b.id) throw new LedgerError("That is your own account", "SELF");
    if (a.balances[asset].available < amount) throw new LedgerError("Insufficient available balance", "INSUFFICIENT");
    a.balances[asset].available -= amount;
    b.balances[asset].available += amount;
    this.emit({ kind: "transfer", account: a.id, settlement: "instant", detail: { to: b.id, asset, amount: amount.toString() } });
  }

  // ---------- swap pool (constant product, no fee) ----------

  quote(assetIn: Asset, assetOut: Asset, amountIn: bigint): bigint {
    assertAsset(assetIn);
    assertAsset(assetOut);
    if (assetIn === assetOut) throw new LedgerError("Same asset", "BAD_PAIR");
    assertPositive(amountIn);
    const rIn = this.state.pool.reserves[assetIn];
    const rOut = this.state.pool.reserves[assetOut];
    if (rIn === 0n || rOut === 0n) throw new LedgerError("Pool has no liquidity", "NO_LIQUIDITY");
    // x * y = k  →  out = rOut - k / (rIn + in)
    const k = rIn * rOut;
    const newIn = rIn + amountIn;
    const newOut = k / newIn + (k % newIn === 0n ? 0n : 1n); // round up what stays in pool
    const out = rOut - newOut;
    if (out <= 0n) throw new LedgerError("Amount too small", "BAD_AMOUNT");
    return out;
  }

  swap(accountId: string, assetIn: Asset, assetOut: Asset, amountIn: bigint, minOut: bigint = 0n): bigint {
    const acct = this.getAccount(accountId);
    const out = this.quote(assetIn, assetOut, amountIn);
    if (out < minOut) throw new LedgerError("Price moved beyond your limit", "SLIPPAGE");
    if (acct.balances[assetIn].available < amountIn) throw new LedgerError("Insufficient available balance", "INSUFFICIENT");
    acct.balances[assetIn].available -= amountIn;
    acct.balances[assetOut].available += out;
    this.state.pool.reserves[assetIn] += amountIn;
    this.state.pool.reserves[assetOut] -= out;
    this.emit({ kind: "swap", account: acct.id, settlement: "instant", detail: { assetIn, amountIn: amountIn.toString(), assetOut, amountOut: out.toString() } });
    return out;
  }

  /** Liquidity provider moves their own balance into the pool. Demo-only: no LP tokens, no withdrawal of liquidity. */
  addLiquidity(accountId: string, asset: Asset, amount: bigint) {
    assertAsset(asset);
    assertPositive(amount);
    const acct = this.getAccount(accountId);
    if (acct.balances[asset].available < amount) throw new LedgerError("Insufficient available balance", "INSUFFICIENT");
    acct.balances[asset].available -= amount;
    this.state.pool.reserves[asset] += amount;
    this.emit({ kind: "add_liquidity", account: acct.id, settlement: "instant", detail: { asset, amount: amount.toString() } });
  }

  // ---------- withdrawals (lock → sign → confirm) ----------

  requestWithdrawal(accountId: string, asset: Asset, amount: bigint, feeReserved: bigint, destination: string): Withdrawal {
    assertAsset(asset);
    assertPositive(amount);
    if (feeReserved < 0n) throw new LedgerError("Bad fee", "BAD_AMOUNT");
    const acct = this.getAccount(accountId);
    const total = amount + feeReserved;
    if (acct.balances[asset].available < total) throw new LedgerError("Insufficient available balance for amount plus fee", "INSUFFICIENT");
    acct.balances[asset].available -= total;
    acct.balances[asset].pending += total;
    const id = String(Object.keys(this.state.withdrawals).length + 1); // shown on screen as "withdrawal #3"
    const w: Withdrawal = {
      id,
      account: acct.id,
      asset,
      amount,
      feeReserved,
      destination: destination.toLowerCase(),
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.state.withdrawals[id] = w;
    this.emit({ kind: "withdraw_requested", account: acct.id, settlement: "onchain", detail: { withdrawalId: id, asset, amount: amount.toString(), destination: w.destination } });
    return w;
  }

  markWithdrawalSent(id: string, fromAddress: string, txHash: string, nonce?: number) {
    const w = this.getWithdrawal(id);
    if (w.status !== "pending") throw new LedgerError(`Withdrawal is ${w.status}`, "BAD_STATE");
    w.status = "sent";
    w.fromAddress = fromAddress.toLowerCase();
    w.txHash = txHash;
    w.nonce = nonce;
    w.updatedAt = Date.now();
    this.emit({ kind: "withdraw_sent", account: w.account, settlement: "onchain", detail: { withdrawalId: id, txHash, fromAddress: w.fromAddress } });
  }

  /** Withdrawal confirmed on-chain. Settle: pending cleared, real fee charged, unused reserve refunded. */
  completeWithdrawal(id: string, feeActual: bigint) {
    const w = this.getWithdrawal(id);
    if (w.status !== "sent") throw new LedgerError(`Withdrawal is ${w.status}`, "BAD_STATE");
    const acct = this.getAccount(w.account);
    const reserved = w.amount + w.feeReserved;
    acct.balances[w.asset].pending -= reserved;
    const refund = w.feeReserved - feeActual;
    if (refund > 0n) acct.balances[w.asset].available += refund;
    // If the real fee exceeded the reserve, the shortfall comes from available (bounded by the cap set at request time).
    if (refund < 0n) acct.balances[w.asset].available += refund;
    w.feeActual = feeActual;
    w.status = "complete";
    w.updatedAt = Date.now();
    this.emit({ kind: "withdraw_complete", account: w.account, settlement: "onchain", detail: { withdrawalId: id, feeActual: feeActual.toString() } });
  }

  /**
   * Withdrawal could not be sent (or the signer refused, or it reverted). Unlock everything, less any network fee a
   * reverted transaction really paid.
   */
  failWithdrawal(id: string, error: string, feePaid = 0n) {
    const w = this.getWithdrawal(id);
    if (w.status === "complete") throw new LedgerError("Already complete", "BAD_STATE");
    const acct = this.getAccount(w.account);
    const reserved = w.amount + w.feeReserved;
    acct.balances[w.asset].pending -= reserved;
    acct.balances[w.asset].available += reserved - feePaid;
    if (feePaid > 0n) w.feeActual = feePaid;
    w.status = "failed";
    w.error = error;
    w.updatedAt = Date.now();
    this.emit({ kind: "withdraw_failed", account: w.account, settlement: "onchain", detail: { withdrawalId: id, error } });
  }

  getWithdrawal(id: string): Withdrawal {
    const w = this.state.withdrawals[id];
    if (!w) throw new LedgerError("Unknown withdrawal", "NO_WITHDRAWAL");
    return w;
  }

  pendingWithdrawals(): Withdrawal[] {
    return Object.values(this.state.withdrawals).filter((w) => w.status === "pending");
  }

  sentWithdrawals(): Withdrawal[] {
    return Object.values(this.state.withdrawals).filter((w) => w.status === "sent");
  }

  // ---------- solvency ----------

  /** Everything the ledger owes for an asset: all users' available + pending, plus pool reserves. */
  totalLiabilities(asset: Asset): bigint {
    assertAsset(asset);
    let t = this.state.pool.reserves[asset];
    for (const a of Object.values(this.state.accounts)) t += a.balances[asset].available + a.balances[asset].pending;
    return t;
  }

  // ---------- earn (pooled Aave supply) ----------

  get earn(): EarnState {
    return (this.state.earn ??= { shares: {}, ops: {} });
  }

  totalShares(asset: Asset): bigint {
    return this.earn.shares[asset] ?? 0n;
  }

  sharesOf(accountId: string, asset: Asset): bigint {
    return this.getAccount(accountId).earnShares?.[asset] ?? 0n;
  }

  /** What an account's shares are worth, given the vault's total supplied (its aWETH, read from the chain). */
  earningValue(accountId: string, asset: Asset, supplied: bigint): bigint {
    const total = this.totalShares(asset);
    return total === 0n ? 0n : (this.sharesOf(accountId, asset) * supplied) / total;
  }

  private newEarnId(): string {
    return String(Object.keys(this.earn.ops).length + 1);
  }

  /** Lock an amount (plus a fee reserve) to be supplied to Aave. */
  requestSupply(accountId: string, asset: Asset, amount: bigint, feeReserved: bigint, ref?: string): EarnOp {
    assertAsset(asset);
    if (amount <= 0n) throw new LedgerError("Amount must be positive", "BAD_AMOUNT");
    const acct = this.getAccount(accountId);
    const bal = acct.balances[asset];
    if (bal.available < amount + feeReserved) throw new LedgerError(`Insufficient balance: the supply plus a network fee of up to ${formatEth(feeReserved)} ETH is more than you have available`, "INSUFFICIENT");
    bal.available -= amount + feeReserved;
    bal.pending += amount + feeReserved;
    const op: EarnOp = { id: this.newEarnId(), account: acct.id, asset, kind: "supply", amount, shares: 0n, feeReserved, feePaid: 0n, status: "pending", ref, createdAt: Date.now(), updatedAt: Date.now() };
    this.earn.ops[op.id] = op;
    this.emit({ kind: "earn_requested", account: acct.id, settlement: "onchain", detail: { earnId: op.id, direction: "supply", asset, amount: amount.toString() } });
    return op;
  }

  /**
   * Set aside shares worth `amount` (or all of them) to be withdrawn from Aave. The shares stay in the pool's total
   * until the withdrawal confirms, so the price of everyone else's shares does not move meanwhile.
   */
  requestRedeem(accountId: string, asset: Asset, amount: bigint | "all", supplied: bigint, ref?: string): EarnOp {
    assertAsset(asset);
    const acct = this.getAccount(accountId);
    const mine = this.sharesOf(acct.id, asset);
    const total = this.totalShares(asset);
    if (mine === 0n || total === 0n || supplied === 0n) throw new LedgerError("You have nothing earning on Aave", "NOTHING_EARNING");
    let shares: bigint;
    let value: bigint;
    if (amount === "all") {
      shares = mine;
      value = (mine * supplied) / total;
    } else {
      if (amount <= 0n) throw new LedgerError("Amount must be positive", "BAD_AMOUNT");
      shares = (amount * total + supplied - 1n) / supplied; // round up: the user gives up at least what they take
      if (shares > mine) throw new LedgerError(`That is more than you have earning (${formatEth((mine * supplied) / total)} ETH)`, "INSUFFICIENT");
      value = amount;
    }
    acct.earnShares![asset] = mine - shares;
    const op: EarnOp = { id: this.newEarnId(), account: acct.id, asset, kind: "redeem", amount: value, shares, feeReserved: 0n, feePaid: 0n, status: "pending", ref, createdAt: Date.now(), updatedAt: Date.now() };
    this.earn.ops[op.id] = op;
    this.emit({ kind: "earn_requested", account: acct.id, settlement: "onchain", detail: { earnId: op.id, direction: "redeem", asset, amount: value.toString() } });
    return op;
  }

  getEarnOp(id: string): EarnOp {
    const op = this.earn.ops[id];
    if (!op) throw new LedgerError("Unknown earn operation", "NO_EARN_OP");
    return op;
  }

  /** An approval (redeem only) or the Aave call itself was broadcast. */
  markEarnSent(id: string, fields: { txHash?: string; approveTxHash?: string; fromAddress: string; nonce: number }) {
    const op = this.getEarnOp(id);
    Object.assign(op, fields, { status: fields.approveTxHash && !fields.txHash ? "approving" : "sent", updatedAt: Date.now() });
    if (fields.txHash) this.emit({ kind: "earn_sent", account: op.account, settlement: "onchain", detail: { earnId: id, txHash: fields.txHash, direction: op.kind } });
  }

  /** The approval confirmed: back to pending, so the withdrawal itself is sent next. */
  approvalConfirmed(id: string, fee: bigint) {
    const op = this.getEarnOp(id);
    op.feePaid += fee;
    op.status = "pending";
    op.updatedAt = Date.now();
  }

  /**
   * The supply or withdrawal confirmed. For a supply, `supplied` is the vault's total aWETH read after it landed: the
   * new shares are priced at what the pool was worth before this supply.
   */
  completeEarn(id: string, fee: bigint, supplied: bigint) {
    const op = this.getEarnOp(id);
    if (op.status === "complete") throw new LedgerError("Already complete", "BAD_STATE");
    op.feePaid += fee;
    const acct = this.getAccount(op.account);
    const bal = acct.balances[op.asset];
    if (op.kind === "supply") {
      const total = this.totalShares(op.asset);
      const before = supplied - op.amount;
      op.shares = total === 0n || before <= 0n ? op.amount : (op.amount * total) / before;
      bal.pending -= op.amount + op.feeReserved;
      bal.available += op.feeReserved - op.feePaid;
      acct.earnShares = { ...(acct.earnShares ?? {}), [op.asset]: (acct.earnShares?.[op.asset] ?? 0n) + op.shares };
      this.earn.shares[op.asset] = total + op.shares;
    } else {
      this.earn.shares[op.asset] = this.totalShares(op.asset) - op.shares;
      bal.available += op.amount - op.feePaid;
    }
    op.status = "complete";
    op.updatedAt = Date.now();
    this.emit({ kind: "earn_complete", account: op.account, settlement: "onchain", detail: { earnId: id, direction: op.kind, asset: op.asset, amount: op.amount.toString(), fee: op.feePaid.toString() } });
  }

  /** It could not be done (refused, or reverted). Everything goes back, less network fees really paid. */
  failEarn(id: string, error: string, feePaid = 0n) {
    const op = this.getEarnOp(id);
    if (op.status === "complete") throw new LedgerError("Already complete", "BAD_STATE");
    op.feePaid += feePaid;
    const acct = this.getAccount(op.account);
    const bal = acct.balances[op.asset];
    if (op.kind === "supply") {
      bal.pending -= op.amount + op.feeReserved;
      bal.available += op.amount + op.feeReserved - op.feePaid;
    } else {
      acct.earnShares![op.asset] = (acct.earnShares?.[op.asset] ?? 0n) + op.shares;
      bal.available -= op.feePaid; // a paid approval is a real cost even if the withdrawal then failed
    }
    op.status = "failed";
    op.error = error;
    op.updatedAt = Date.now();
    this.emit({ kind: "earn_failed", account: op.account, settlement: "onchain", detail: { earnId: id, direction: op.kind, error } });
  }

  // ---------- events ----------

  private emit(e: Omit<LedgerEvent, "id" | "at">) {
    this.state.events.push({ id: this.state.nextEventId++, at: Date.now(), ...e });
    if (this.state.events.length > 2000) this.state.events.splice(0, this.state.events.length - 2000);
  }

  eventsFor(accountId?: string, limit = 50): LedgerEvent[] {
    const all = accountId
      ? this.state.events.filter((e) => e.account === accountId.toLowerCase() || e.detail.to === accountId.toLowerCase())
      : this.state.events;
    return all.slice(-limit).reverse();
  }
}
