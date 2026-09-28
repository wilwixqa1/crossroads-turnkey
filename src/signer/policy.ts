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
 *   Aave          allow supplying ETH through Aave's gateway, and withdrawing it, only for the vault address itself
 *                 allow approving the gateway to take back the vault's aWETH (needed to withdraw)
 *                 deny every way to open debt: borrow, flash loans, borrowing through the gateway, credit delegation
 */
import { decodeFunctionData, formatEther, getAddress, type Abi, type Address, type TransactionSerializable } from "viem";
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
  aaveSupply: `${SIGNER_PREFIX} Aave supply and withdraw only`,
  aaveApprove: `${SIGNER_PREFIX} let Aave's gateway take back supplied ETH`,
  neverBorrow: `${SIGNER_PREFIX} never borrow on Aave`,
};

/** An address as a policy-language list of its lowercase and checksummed forms, so either spelling matches. */
function forms(a: Address): string {
  return `['${a.toLowerCase()}', '${getAddress(a)}']`;
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
  for (const m of aave) {
    const fn = (name: string) => `eth.tx.function_name == '${name}'`;
    const arg = (name: string) => `eth.tx.contract_call_args['${name}']`;
    out.push({
      policyName: names.aaveSupply,
      effect: "EFFECT_ALLOW",
      consensus,
      condition:
        `${mine} && eth.tx.chain_id == ${m.chainId} && eth.tx.to in ${forms(m.gateway)} && ${arg("pool")} in ${forms(m.pool)} && ` +
        `((${fn("depositETH")} && ${arg("onBehalfOf")} == eth.tx.from) || (${fn("withdrawETH")} && ${arg("to")} == eth.tx.from && eth.tx.value == 0))`,
      notes: "Supply ETH to Aave through its gateway, or withdraw it, only for the vault address making the call.",
    });
    out.push({
      policyName: names.aaveApprove,
      effect: "EFFECT_ALLOW",
      consensus,
      condition: `${mine} && eth.tx.chain_id == ${m.chainId} && eth.tx.to in ${forms(m.aWeth)} && ${fn("approve")} && ${arg("spender")} in ${forms(m.gateway)} && eth.tx.value == 0`,
      notes: "Withdrawing through the gateway needs it to take the vault's aWETH back. The gateway is the only spender allowed.",
    });
    out.push({
      policyName: names.neverBorrow,
      effect: "EFFECT_DENY",
      consensus,
      condition:
        `${isTx} && ((eth.tx.to in ${forms(m.pool)} && eth.tx.function_name in ['borrow', 'flashLoan', 'flashLoanSimple']) || ` +
        `(eth.tx.to in ${forms(m.gateway)} && ${fn("borrowETH")}) || (eth.tx.to in ${forms(m.vDebt)} && ${fn("approveDelegation")}))`,
      notes: "The vault can never open debt, so pooled funds supplied to Aave can never be liquidated.",
    });
  }
  return out;
}

/** The contracts whose interfaces Turnkey needs, so its policies can read function names and arguments. */
export function contractInterfaces(aave: AaveMarket[]): { label: string; address: Address; abi: Abi }[] {
  return aave.flatMap((m) => [
    { label: "Aave v3 Pool (Sepolia)", address: m.pool, abi: POOL_ABI as Abi },
    { label: "Aave WETH gateway (Sepolia)", address: m.gateway, abi: GATEWAY_ABI as Abi },
    { label: "Aave aWETH (Sepolia)", address: m.aWeth, abi: ERC20_ABI as Abi },
    { label: "Aave variable-debt WETH (Sepolia)", address: m.vDebt, abi: DEBT_TOKEN_ABI as Abi },
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
        return { allowed: true, policy: names.aaveSupply, reason: "supplying ETH to Aave for the vault address itself", call: `Aave depositETH, ${formatEther(value)} ETH, on behalf of ${from}` };
      }
      if (call.functionName === "withdrawETH" && same(call.args[2] as string, from) && value === 0n) {
        return { allowed: true, policy: names.aaveSupply, reason: "withdrawing ETH from Aave back to the vault address itself", call: `Aave withdrawETH, ${formatEther(call.args[1] as bigint)} ETH, to ${from}` };
      }
    }
  }
  if (market && same(to, market.aWeth)) {
    const call = decode(ERC20_ABI as Abi, tx.data);
    if (call?.functionName === "approve" && same(call.args[0] as string, market.gateway) && value === 0n) {
      return { allowed: true, policy: names.aaveApprove, reason: "letting Aave's gateway take back the vault's aWETH", call: "aWETH approve, spender: Aave's gateway" };
    }
  }
  return { allowed: false, reason: "no policy allows this transaction (only plain transfers and Aave supply and withdraw are allowed)" };
}
