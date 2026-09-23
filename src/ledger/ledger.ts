/**
 * The Crossroads ledger.
 *
 * Off-chain bookkeeping for a pooled, encumbered vault. Mirrors the rules of the
 * Crossroads asset contract (deposit → credit once, lock before sign, confirm
 * withdrawal → settle fee) but runs inside the ROFL app instead of on-chain.
 *
 * All amounts are bigint in the asset's smallest unit (wei).
 */

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
  createdAt: number;
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
    | "withdraw_failed";
  settlement: "instant" | "onchain";
  detail: Record<string, string | number>;
}

export interface LedgerState {
  accounts: Record<string, Account>;
  /** key: `${asset}:${txHash.toLowerCase()}` → account credited */
  deposits: Record<string, string>;
  withdrawals: Record<string, Withdrawal>;
  pool: Pool;
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
    const b = this.getAccount(to);
    if (a.id === b.id) throw new LedgerError("Cannot transfer to self", "SELF");
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

  /** Withdrawal could not be sent (or the signer refused). Unlock everything. */
  failWithdrawal(id: string, error: string) {
    const w = this.getWithdrawal(id);
    if (w.status === "complete") throw new LedgerError("Already complete", "BAD_STATE");
    const acct = this.getAccount(w.account);
    const reserved = w.amount + w.feeReserved;
    acct.balances[w.asset].pending -= reserved;
    acct.balances[w.asset].available += reserved;
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
