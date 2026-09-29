/** Display helpers. Amounts arrive from the API as decimal strings of wei and stay bigint here. */

const WEI = 10n ** 18n;

/** Wei to ETH with a fixed number of decimals, rounded toward zero so a balance is never overstated. */
export function fmtEth(wei: string | bigint, decimals = 4): string {
  let v = typeof wei === "bigint" ? wei : BigInt(wei);
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / WEI;
  const frac = ((v % WEI) * 10n ** BigInt(decimals)) / WEI;
  const body = decimals > 0 ? `${whole}.${frac.toString().padStart(decimals, "0")}` : whole.toString();
  return neg ? `-${body}` : body;
}

/** What a person typed ("0.01", ".5", "2") to wei. Throws a message fit to show on screen. */
export function parseEthInput(text: string): bigint {
  const s = text.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!s || !m || (!m[1] && !m[2])) throw new Error("Enter an amount, like 0.01");
  const frac = m[2] ?? "";
  if (frac.length > 18) throw new Error("Use at most 18 decimal places");
  const wei = BigInt(m[1] || "0") * WEI + BigInt(frac.padEnd(18, "0") || "0");
  if (wei === 0n) throw new Error("Enter an amount above zero");
  return wei;
}

export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

/** A Turnkey activity ID the way Turnkey's dashboard shows it: first 4 and last 4 characters (IDs start with a timestamp). */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}····${id.slice(-4)}` : id;
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Settlement and signing times: sub-millisecond ledger moves need two decimals to be visible at all. */
export function fmtMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Wall-clock time for log rows, so timings can be read against each other on screen. */
export function fmtClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Spot price of the pool: how much `out` one unit of `in` buys at current reserves, before price impact. */
export function spotRate(reserveIn: string | bigint, reserveOut: string | bigint): bigint | null {
  const rIn = BigInt(reserveIn);
  const rOut = BigInt(reserveOut);
  if (rIn === 0n || rOut === 0n) return null;
  return (rOut * WEI) / rIn;
}

/** A token amount in its smallest units (e.g. USDC's 6 decimals) with `shown` decimals, rounded toward zero. */
export function fmtUnits(value: string | bigint, decimals: number, shown = 2): string {
  const v = typeof value === "bigint" ? value : BigInt(value);
  const one = 10n ** BigInt(decimals);
  const whole = v / one;
  const frac = ((v % one) * 10n ** BigInt(shown)) / one;
  return shown > 0 ? `${whole}.${frac.toString().padStart(shown, "0")}` : whole.toString();
}

/** US dollars from Aave's figures (8 decimals), as "$53.63". */
export function fmtUsd(base8: string | bigint): string {
  return `$${fmtUnits(base8, 8, 2)}`;
}

/** What a person typed to a token's smallest units. Throws a message fit to show on screen. */
export function parseUnitsInput(text: string, decimals: number, example = "10"): bigint {
  const s = text.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!s || !m || (!m[1] && !m[2])) throw new Error(`Enter an amount, like ${example}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`Use at most ${decimals} decimal places`);
  const units = BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (units === 0n) throw new Error("Enter an amount above zero");
  return units;
}
