import { describe, it, expect } from "vitest";
import { fmtEth, parseEthInput, fmtMs, spotRate, isAddress } from "../web/format.js";
import { EvmChain } from "../src/chains/evm.js";

const ETH = 10n ** 18n;

describe("amounts on the page", () => {
  it("shows four decimals and never rounds a balance up", () => {
    expect(fmtEth(ETH)).toBe("1.0000");
    expect(fmtEth("38299500000000000")).toBe("0.0382");
    expect(fmtEth(99_999n * 10n ** 13n)).toBe("0.9999");
    expect(fmtEth(-ETH / 2n)).toBe("-0.5000");
  });

  it("reads what a person types into wei, with plain error messages", () => {
    expect(parseEthInput("0.01")).toBe(ETH / 100n);
    expect(parseEthInput(".5")).toBe(ETH / 2n);
    expect(parseEthInput(" 2 ")).toBe(2n * ETH);
    expect(parseEthInput("0.000000000000000001")).toBe(1n);
    expect(() => parseEthInput("")).toThrow(/Enter an amount/);
    expect(() => parseEthInput("abc")).toThrow(/Enter an amount/);
    expect(() => parseEthInput("0")).toThrow(/above zero/);
    expect(() => parseEthInput("1.0000000000000000001")).toThrow(/18 decimal/);
  });

  it("makes sub-millisecond settlement visible", () => {
    expect(fmtMs(0.17)).toBe("0.17 ms");
    expect(fmtMs(18.4)).toBe("18 ms");
    expect(fmtMs(1500)).toBe("1.5 s");
  });

  it("prices the pool from its two balances, and says nothing when it is empty", () => {
    expect(spotRate(ETH, 2n * ETH)).toBe(2n * ETH);
    expect(spotRate(0n, ETH)).toBeNull();
    expect(isAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe(true);
    expect(isAddress("0x1234")).toBe(false);
  });
});

describe("amounts in Under the hood sentences", () => {
  it("rounds fees to six decimals instead of printing every digit", () => {
    expect(EvmChain.fmt(33_775_697_466_000n)).toBe("0.000034");
    expect(EvmChain.fmt(ETH / 10n)).toBe("0.1");
    expect(EvmChain.fmt(1n)).toBe("less than 0.000001");
    expect(EvmChain.fmt(0n)).toBe("0");
  });
});
