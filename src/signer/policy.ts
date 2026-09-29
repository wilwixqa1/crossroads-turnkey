/**
 * The vault signer's rules, in one place.
 *
 * signerPolicies() writes them in Turnkey's policy language; Turnkey enforces them on every signature.
 * evaluate() applies the same rules in plain code: the stand-in vault uses it to refuse what Turnkey would refuse, and
 * the Turnkey vault uses it only to say, in words, why Turnkey refused something.
 *
 * The rules (Turnkey denies anything no policy allows, and a deny beats any allow):
 *   per network   allow a plain ETH transfer from the vault wallet up to that network's limit
 *                 deny anything worth more than that network's limit
 *   Aave          allow supplying ETH through Aave's gateway only for the vault address itself, and withdrawing it only
 *                 back to that address
 *                 allow approving the gateway to take back the vault's aWETH (needed to withdraw)
 *                 deny every way to open debt: borrow, flash loans, borrowing through the gateway, credit delegation
 */
import { decodeFunctionData, formatEther, type Abi, type Address, type TransactionSerializable } from "viem";
import { DEBT_TOKEN_ABI, ERC20_ABI, GATEWAY_ABI, POOL_ABI, type AaveMarket } from "../chains/aave.js";

export interface ChainLimit {
  chainId: number;
  name: string;
  cap: bigint;
}

export interface PolicySpec {
  policyName: string;
  effect: "EFFECT_ALLOW" | "EFFECT_DENY";
  consensus: string;
  condition: string;
  notes: string;
}

/** Every signer policy's name starts with this, so the admin can find and replace them. */
export const SIGNER_PREFIX = "Vault signer:";

/** A plain ETH transfer uses exactly 21,000 gas. A transaction capped there cannot call any contract. */
export const PLAIN_TRANSFER_GAS = 21_000n;

export const names = {
  withdrawals: (l: ChainLimit) => `${SIGNER_PREFIX} withdrawals on ${l.name}, up to ${formatEther(l.cap)} ETH`,
  cap: (l: ChainLimit) => `${SIGNER_PREFIX} never more than ${formatEther(l.cap)} ETH per withdrawal on ${l.name}`,
  aaveSupply: (m: { name: string }) => `${SIGNER_PREFIX} Aave supply, only for the vault itself, on ${m.name}`,
  aaveWithdraw: (m: { name: string }) => `${SIGNER_PREFIX} Aave withdraw, only back to the vault itself, on ${m.name}`,
  aaveApprove: (m: { name: string }) => `${SIGNER_PREFIX} let Aave's gateway take back supplied ETH, on ${m.name}`,
  neverBorrow: `${SIGNER_PREFIX} never borrow on Aave`,
};

/** An address in a policy. Turnkey compares addresses regardless of case (tested Sept 28); its docs ask for lowercase. */
function addr(a: Address): string {
  return `'${a.toLowerCase()}'`;
}

export function signerPolicies(signerUserId: string, walletId: string, limits: ChainLimit[], aave: AaveMarket[] = []): PolicySpec[] {
  const consensus = `approvers.any(user, user.id == '${signerUserId}')`;
  const isTx = "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'";
  const mine = `${isTx} && wallet.id == '${walletId}'`;
  const out: PolicySpec[] = [];
  for (const l of limits) {
    out.push({
      policyName: names.withdrawals(l),
      effect: "EFFECT_ALLOW",
      consensus,
      condition: `${mine} && eth.tx.chain_id == ${l.chainId} && eth.tx.value <= ${l.cap} && eth.tx.gas == ${PLAIN_TRANSFER_GAS}`,
      notes: `A plain ETH transfer from the vault wallet on ${l.name}, up to ${formatEther(l.cap)} ETH. Capped at 21,000 gas, so it cannot call a contract.`,
    });
    out.push({
      policyName: names.cap(l),
      effect: "EFFECT_DENY",
      consensus,
      condition: `${isTx} && eth.tx.chain_id == ${l.chainId} && eth.tx.value > ${l.cap}`,
      notes: "Circuit breaker: holds even if the app itself asks.",
    });
  }
  // NEXT PERSON: Turnkey's policy engine does not short-circuit, and reading an argument the call does not have (say
  // 'spender' on depositETH) makes the whole policy evaluate to an error. An error neither allows nor denies (tested
  // on a throwaway vault Sept 28: a plain transfer still signed while these three errored). So each allow names one
  // function and reads only that function's arguments, and the deny reads no arguments: a deny that errors is ignored.
  for (const m of aave) {
    const fn = (name: string) => `eth.tx.function_name == '${name}'`;
    const arg = (name: string) => `eth.tx.contract_call_args['${name}']`;
    const onMarket = `${mine} && eth.tx.chain_id == ${m.chainId}`;
    out.push({
      policyName: names.aaveSupply(m),
      effect: "EFFECT_ALLOW",
      consensus,
      condition: `${onMarket} && eth.tx.to == ${addr(m.gateway)} && ${fn("depositETH")} && ${arg("pool")} == ${addr(m.pool)} && ${arg("onBehalfOf")} == eth.tx.from`,
      notes: "Supply ETH to Aave through its gateway, only for the vault address making the call.",
    });
    out.push({
      policyName: names.aaveWithdraw(m),
      effect: "EFFECT_ALLOW",
      consensus,
      condition: `${onMarket} && eth.tx.to == ${addr(m.gateway)} && ${fn("withdrawETH")} && ${arg("pool")} == ${addr(m.pool)} && ${arg("to")} == eth.tx.from && eth.tx.value == 0`,
      notes: "Withdraw supplied ETH from Aave, only back to the vault address making the call.",
    });
    out.push({
      policyName: names.aaveApprove(m),
      effect: "EFFECT_ALLOW",
      consensus,
      condition: `${onMarket} && eth.tx.to == ${addr(m.aWeth)} && ${fn("approve")} && ${arg("spender")} == ${addr(m.gateway)} && eth.tx.value == 0`,
      notes: "Withdrawing through the gateway needs it to take the vault's aWETH back. The gateway is the only spender allowed.",
    });
    out.push({
      policyName: names.neverBorrow,
      effect: "EFFECT_DENY",
      consensus,
      condition:
        `${isTx} && ((eth.tx.to == ${addr(m.pool)} && eth.tx.function_name in ['borrow', 'flashLoan', 'flashLoanSimple']) || ` +
        `(eth.tx.to == ${addr(m.gateway)} && ${fn("borrowETH")}) || (eth.tx.to == ${addr(m.vDebt)} && ${fn("approveDelegation")}))`,
      notes: "The vault can never open debt, so pooled funds supplied to Aave can never be liquidated.",
    });
  }
  return out;
}

/**
 * An ABI in the form Turnkey accepts. Turnkey rejects ("provided ABI is invalid") any parameter without a name field,
 * and viem leaves unnamed return values without one, so every parameter gets a name, empty if it had none.
 */
export function turnkeyAbi(abi: Abi): string {
  const named = (params: readonly Record<string, unknown>[] = []): Record<string, unknown>[] =>
    params.map((p) => ({ ...p, name: p.name ?? "", ...(p.components ? { components: named(p.components as Record<string, unknown>[]) } : {}) }));
  return JSON.stringify(
    abi.map((item) => ({
      ...item,
      ...("inputs" in item ? { inputs: named(item.inputs as unknown as Record<string, unknown>[]) } : {}),
      ...("outputs" in item ? { outputs: named(item.outputs as unknown as Record<string, unknown>[]) } : {}),
    })),
  );
}

/** The contracts whose interfaces Turnkey needs, so its policies can read function names and arguments. */
export function contractInterfaces(aave: AaveMarket[]): { label: string; address: Address; abi: Abi }[] {
  return aave.flatMap((m) => [
    { label: `Aave v3 Pool (${m.name})`, address: m.pool, abi: POOL_ABI as Abi },
    { label: `Aave WETH gateway (${m.name})`, address: m.gateway, abi: GATEWAY_ABI as Abi },
    { label: `Aave aWETH (${m.name})`, address: m.aWeth, abi: ERC20_ABI as Abi },
    { label: `Aave variable-debt WETH (${m.name})`, address: m.vDebt, abi: DEBT_TOKEN_ABI as Abi },
  ]);
}

export interface Verdict {
  allowed: boolean;
  /** The rule that decided, by policy name, or undefined when no rule matched (Turnkey's implicit deny). */
  policy?: string;
  /** Plain words: what the transaction was and why it was allowed or refused. */
  reason: string;
  /** The call as Turnkey decodes it, e.g. "Aave depositETH, 0.02 ETH, on behalf of 0xabc…". */
  call?: string;
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

function decode(abi: Abi, data?: string): { functionName: string; args: readonly unknown[] } | undefined {
  if (!data || data === "0x") return undefined;
  try {
    const d = decodeFunctionData({ abi, data: data as `0x${string}` });
    return { functionName: d.functionName, args: d.args ?? [] };
  } catch {
    return undefined;
  }
}

/** The vault signer's rules as plain code: the same decisions signerPolicies() asks Turnkey to make. */
export function evaluate(tx: TransactionSerializable, from: string, limits: ChainLimit[], aave: AaveMarket[] = []): Verdict {
  const value = tx.value ?? 0n;
  const limit = limits.find((l) => l.chainId === tx.chainId);
  const market = aave.find((m) => m.chainId === tx.chainId);
  const to = tx.to ?? undefined;

  // Denies first: a deny beats any allow.
  if (limit && value > limit.cap) return { allowed: false, policy: names.cap(limit), reason: `${formatEther(value)} ETH is above the ${formatEther(limit.cap)} ETH per-withdrawal limit on ${limit.name}` };
  for (const m of aave) {
    const call =
      (same(to, m.pool) && decode(POOL_ABI as Abi, tx.data)) ||
      (same(to, m.gateway) && decode(GATEWAY_ABI as Abi, tx.data)) ||
      (same(to, m.vDebt) && decode(DEBT_TOKEN_ABI as Abi, tx.data)) ||
      undefined;
    if (call && ["borrow", "flashLoan", "flashLoanSimple", "borrowETH", "approveDelegation"].includes(call.functionName)) {
      return { allowed: false, policy: names.neverBorrow, reason: `the vault may never open debt on Aave (${call.functionName})`, call: `Aave ${call.functionName}` };
    }
  }

  if (!limit) return { allowed: false, reason: `chain ${tx.chainId} is not one the vault may sign for` };
  if ((tx.data === undefined || tx.data === "0x") && tx.gas === PLAIN_TRANSFER_GAS) {
    return { allowed: true, policy: names.withdrawals(limit), reason: `${formatEther(value)} ETH, within the ${formatEther(limit.cap)} ETH limit on ${limit.name}` };
  }
  if (market && same(to, market.gateway)) {
    const call = decode(GATEWAY_ABI as Abi, tx.data);
    if (call && same(call.args[0] as string, market.pool)) {
      if (call.functionName === "depositETH" && same(call.args[1] as string, from)) {
        return { allowed: true, policy: names.aaveSupply(market), reason: "supplying ETH to Aave for the vault address itself", call: `Aave depositETH, ${formatEther(value)} ETH, on behalf of ${from}` };
      }
      if (call.functionName === "withdrawETH" && same(call.args[2] as string, from) && value === 0n) {
        return { allowed: true, policy: names.aaveWithdraw(market), reason: "withdrawing ETH from Aave back to the vault address itself", call: `Aave withdrawETH, ${formatEther(call.args[1] as bigint)} ETH, to ${from}` };
      }
    }
  }
  if (market && same(to, market.aWeth)) {
    const call = decode(ERC20_ABI as Abi, tx.data);
    if (call?.functionName === "approve" && same(call.args[0] as string, market.gateway) && value === 0n) {
      return { allowed: true, policy: names.aaveApprove(market), reason: "letting Aave's gateway take back the vault's aWETH", call: "aWETH approve, spender: Aave's gateway" };
    }
  }
  return { allowed: false, reason: "no policy allows this transaction (only plain transfers and Aave supply and withdraw are allowed)" };
}
