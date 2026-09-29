import { describe, it, expect } from "vitest";
import { encodeFunctionData, parseEther, type TransactionSerializable } from "viem";
import { evaluate, names, turnkeyAbi } from "../src/signer/policy.js";
import { AAVE_MARKETS, DEBT_TOKEN_ABI, ERC20_ABI, GATEWAY_ABI, POOL_ABI } from "../src/chains/aave.js";

const LIMITS = [
  { chainId: 11155111, name: "Sepolia", cap: parseEther("0.05") },
  { chainId: 84532, name: "Base Sepolia", cap: parseEther("0.02") },
];
const M = AAVE_MARKETS[0];
const VAULT = "0x0beac0e5b61a8db1d211bb638f21dff5af2bcea1";
const OTHER = "0x9999999999999999999999999999999999999999";
const plain = (eth: string, chainId = 11155111): TransactionSerializable => ({ chainId, type: "eip1559", to: OTHER, value: parseEther(eth), nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
const call = (to: `0x${string}`, data: `0x${string}`, value = 0n): TransactionSerializable => ({ chainId: M.chainId, type: "eip1559", to, data, value, nonce: 0, gas: 300_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
const check = (tx: TransactionSerializable) => evaluate(tx, VAULT, LIMITS, AAVE_MARKETS);

describe("the vault signer's rules, as the stand-in applies them", () => {
  it("allows a plain transfer up to each network's own limit", () => {
    expect(check(plain("0.05"))).toMatchObject({ allowed: true, policy: names.withdrawals(LIMITS[0]) });
    expect(check(plain("0.02", 84532))).toMatchObject({ allowed: true, policy: names.withdrawals(LIMITS[1]) });
  });

  it("denies anything above a network's limit, by that network's rule", () => {
    expect(check(plain("0.06"))).toMatchObject({ allowed: false, policy: names.cap(LIMITS[0]) });
    expect(check(plain("0.03", 84532))).toMatchObject({ allowed: false, policy: names.cap(LIMITS[1]) });
  });

  it("refuses other networks and any contract call that is not an Aave supply or withdraw", () => {
    const otherChain = check(plain("0.01", 1));
    expect(otherChain.allowed).toBe(false);
    expect(otherChain.policy).toBeUndefined();
    expect(check({ ...plain("0.01"), gas: 50_000n })).toMatchObject({ allowed: false });
    const approveAnyone = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [OTHER, 1n] });
    expect(check(call(M.weth, approveAnyone))).toMatchObject({ allowed: false });
  });

  it("allows supplying ETH to Aave and withdrawing it, only for the vault address itself", () => {
    const self = encodeFunctionData({ abi: GATEWAY_ABI, functionName: "depositETH", args: [M.pool, VAULT, 0] });
    expect(check(call(M.gateway, self, parseEther("0.02")))).toMatchObject({ allowed: true, policy: names.aaveSupply(M) });
    const forSomeoneElse = encodeFunctionData({ abi: GATEWAY_ABI, functionName: "depositETH", args: [M.pool, OTHER, 0] });
    expect(check(call(M.gateway, forSomeoneElse, parseEther("0.02")))).toMatchObject({ allowed: false });
    const back = encodeFunctionData({ abi: GATEWAY_ABI, functionName: "withdrawETH", args: [M.pool, parseEther("0.02"), VAULT] });
    expect(check(call(M.gateway, back))).toMatchObject({ allowed: true, policy: names.aaveWithdraw(M) });
    const away = encodeFunctionData({ abi: GATEWAY_ABI, functionName: "withdrawETH", args: [M.pool, parseEther("0.02"), OTHER] });
    expect(check(call(M.gateway, away))).toMatchObject({ allowed: false });
    const approveGateway = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [M.gateway, parseEther("1")] });
    expect(check(call(M.aWeth, approveGateway))).toMatchObject({ allowed: true, policy: names.aaveApprove(M) });
    expect(check(call(M.gateway, self, parseEther("0.03")))).toMatchObject({ allowed: false, policy: names.cap(LIMITS[1]) });
  });

  it("denies every way to open debt on Aave by the never-borrow rule", () => {
    const WETH = M.weth;
    const attempts: [`0x${string}`, `0x${string}`][] = [
      [M.pool, encodeFunctionData({ abi: POOL_ABI, functionName: "borrow", args: [WETH, parseEther("0.01"), 2n, 0, VAULT] })],
      [M.pool, encodeFunctionData({ abi: POOL_ABI, functionName: "flashLoan", args: [OTHER, [WETH], [1n], [2n], VAULT, "0x", 0] })],
      [M.gateway, encodeFunctionData({ abi: GATEWAY_ABI, functionName: "borrowETH", args: [M.pool, 1n, 0] })],
      [M.vDebt, encodeFunctionData({ abi: DEBT_TOKEN_ABI, functionName: "approveDelegation", args: [OTHER, 1n] })],
    ];
    for (const [to, data] of attempts) expect(check(call(to, data))).toMatchObject({ allowed: false, policy: names.neverBorrow });
  });
});

describe("contract interfaces for Turnkey", () => {
  it("gives every parameter a name, since Turnkey rejects an ABI with an unnamed return value", () => {
    const abi = JSON.parse(turnkeyAbi(ERC20_ABI)) as { outputs: { name?: string }[] }[];
    for (const f of abi) for (const o of f.outputs) expect(o.name).toBe("");
  });
});
