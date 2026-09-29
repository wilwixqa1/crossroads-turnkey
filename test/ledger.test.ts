import { describe, it, expect } from "vitest";
import { Ledger, LedgerError } from "../src/ledger/ledger.js";
import { requestMessage, verifyRequest } from "../src/ledger/requests.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const VAULT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ETH = 10n ** 18n;

function setup() {
  const l = new Ledger();
  l.createAccount(ALICE, "Alice", VAULT_A);
  l.createAccount(BOB, "Bob", VAULT_B);
  return l;
}

describe("deposits", () => {
  it("credits a deposit to the account owning the address, exactly once", () => {
    const l = setup();
    l.creditDeposit("ETH_SEPOLIA", "0xTX1", VAULT_A, ETH);
    expect(l.getAccount(ALICE).balances.ETH_SEPOLIA.available).toBe(ETH);
    expect(() => l.creditDeposit("ETH_SEPOLIA", "0xtx1", VAULT_A, ETH)).toThrow(LedgerError);
    expect(l.getAccount(ALICE).balances.ETH_SEPOLIA.available).toBe(ETH);
  });

  it("rejects deposits to addresses the vault does not own", () => {
    const l = setup();
    expect(() => l.creditDeposit("ETH_SEPOLIA", "0xTX2", "0xcccccccccccccccccccccccccccccccccccccccc", ETH)).toThrow(/unknown address/);
  });
});

describe("instant moves", () => {
  it("transfers between users without touching the total", () => {
    const l = setup();
    l.creditDeposit("ETH_SEPOLIA", "0xTX1", VAULT_A, ETH);
    l.transfer(ALICE, BOB, "ETH_SEPOLIA", ETH / 4n);
    expect(l.getAccount(ALICE).balances.ETH_SEPOLIA.available).toBe((ETH * 3n) / 4n);
    expect(l.getAccount(BOB).balances.ETH_SEPOLIA.available).toBe(ETH / 4n);
    expect(l.totalLiabilities("ETH_SEPOLIA")).toBe(ETH);
    expect(() => l.transfer(BOB, ALICE, "ETH_SEPOLIA", ETH)).toThrow(/Insufficient/);
  });

  it("swaps through the pool and keeps every asset's total constant", () => {
    const l = setup();
    l.creditDeposit("ETH_SEPOLIA", "0xTX1", VAULT_A, 10n * ETH);
    l.creditDeposit("ETH_BASE_SEPOLIA", "0xTX2", VAULT_A, 10n * ETH);
    l.addLiquidity(ALICE, "ETH_SEPOLIA", 9n * ETH);
    l.addLiquidity(ALICE, "ETH_BASE_SEPOLIA", 9n * ETH);
    l.creditDeposit("ETH_SEPOLIA", "0xTX3", VAULT_B, ETH);
    const out = l.swap(BOB, "ETH_SEPOLIA", "ETH_BASE_SEPOLIA", ETH);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(ETH); // price impact
    expect(l.getAccount(BOB).balances.ETH_BASE_SEPOLIA.available).toBe(out);
    expect(l.totalLiabilities("ETH_SEPOLIA")).toBe(11n * ETH);
    expect(l.totalLiabilities("ETH_BASE_SEPOLIA")).toBe(10n * ETH);
  });
});

describe("withdrawals", () => {
  it("locks amount plus fee before anything is signed, then settles the real fee", () => {
    const l = setup();
    l.creditDeposit("ETH_SEPOLIA", "0xTX1", VAULT_A, ETH);
    const w = l.requestWithdrawal(ALICE, "ETH_SEPOLIA", ETH / 2n, ETH / 100n, BOB);
    const bal = () => l.getAccount(ALICE).balances.ETH_SEPOLIA;
    expect(bal().available).toBe(ETH - ETH / 2n - ETH / 100n);
    expect(bal().pending).toBe(ETH / 2n + ETH / 100n);
    // While locked, the user cannot spend it elsewhere.
    expect(() => l.transfer(ALICE, BOB, "ETH_SEPOLIA", ETH / 2n)).toThrow(/Insufficient/);
    l.markWithdrawalSent(w.id, VAULT_A, "0xSENT");
    l.completeWithdrawal(w.id, ETH / 200n); // real fee was half the reserve
    expect(bal().pending).toBe(0n);
    expect(bal().available).toBe(ETH - ETH / 2n - ETH / 200n);
    expect(l.totalLiabilities("ETH_SEPOLIA")).toBe(ETH - ETH / 2n - ETH / 200n);
  });

  it("unlocks everything when the signer refuses", () => {
    const l = setup();
    l.creditDeposit("ETH_SEPOLIA", "0xTX1", VAULT_A, ETH);
    const w = l.requestWithdrawal(ALICE, "ETH_SEPOLIA", ETH / 2n, ETH / 100n, BOB);
    l.failWithdrawal(w.id, "policy denied");
    const bal = l.getAccount(ALICE).balances.ETH_SEPOLIA;
    expect(bal.available).toBe(ETH);
    expect(bal.pending).toBe(0n);
  });

  it("refuses to complete a withdrawal that was never sent", () => {
    const l = setup();
    l.creditDeposit("ETH_SEPOLIA", "0xTX1", VAULT_A, ETH);
    const w = l.requestWithdrawal(ALICE, "ETH_SEPOLIA", ETH / 2n, 0n, BOB);
    expect(() => l.completeWithdrawal(w.id, 0n)).toThrow(/pending/);
  });
});

describe("replay protection", () => {
  it("accepts each sequence number once, in order", () => {
    const l = setup();
    l.consumeSeq(ALICE, 1);
    expect(() => l.consumeSeq(ALICE, 1)).toThrow(/sequence/);
    expect(() => l.consumeSeq(ALICE, 3)).toThrow(/sequence/);
    l.consumeSeq(ALICE, 2);
    expect(l.getAccount(ALICE).nextSeq).toBe(3);
  });

  it("verifies a request signed by the account's own key and rejects a forged one", async () => {
    const key = generatePrivateKey();
    const signer = privateKeyToAccount(key);
    const params = { asset: "ETH_SEPOLIA", amount: "1000", to: BOB };
    const message = requestMessage(signer.address, 1, "transfer", params);
    const signature = await signer.signMessage({ message });
    await expect(verifyRequest({ account: signer.address, seq: 1, action: "transfer", params, signature })).resolves.toBeUndefined();
    // Same signature, different amount → rejected.
    await expect(
      verifyRequest({ account: signer.address, seq: 1, action: "transfer", params: { ...params, amount: "2000" }, signature }),
    ).rejects.toThrow(/Bad signature/);
  });
});

describe("Send recipients", () => {
  it("accepts an account ID or a Crossroads deposit address, and credits the owner either way", () => {
    const l = setup();
    l.creditDeposit("ETH_SEPOLIA", "0xTX9", VAULT_A, ETH);
    expect(l.findRecipient(BOB)?.id).toBe(BOB);
    expect(l.findRecipient(VAULT_B.toUpperCase().replace("0X", "0x"))?.id).toBe(BOB);
    l.transfer(ALICE, VAULT_B, "ETH_SEPOLIA", ETH / 10n);
    expect(l.getAccount(BOB).balances.ETH_SEPOLIA.available).toBe(ETH / 10n);
  });

  it("refuses an address that is not a Crossroads account, with the plain message the page shows", () => {
    const l = setup();
    l.creditDeposit("ETH_SEPOLIA", "0xTX9", VAULT_A, ETH);
    expect(l.findRecipient("0x9999999999999999999999999999999999999999")).toBeUndefined();
    expect(() => l.transfer(ALICE, "0x9999999999999999999999999999999999999999", "ETH_SEPOLIA", 1n)).toThrow(/isn't a Crossroads account/);
    expect(() => l.transfer(ALICE, VAULT_A, "ETH_SEPOLIA", 1n)).toThrow(/your own account/);
  });
});

describe("Earn: pooled Aave supply with per-user shares", () => {
  const A = "ETH_BASE_SEPOLIA" as const;
  const fund = (l: Ledger) => {
    l.creditDeposit(A, "0xa1", VAULT_A, ETH);
    l.creditDeposit(A, "0xb1", VAULT_B, ETH);
  };

  it("locks a supply until it confirms, then gives shares and refunds the unused fee reserve", () => {
    const l = setup();
    fund(l);
    const op = l.requestSupply(ALICE, A, ETH / 50n, 1000n);
    expect(l.getAccount(ALICE).balances[A]).toEqual({ available: ETH - ETH / 50n - 1000n, pending: ETH / 50n + 1000n });
    l.completeEarn(op.id, 400n, ETH / 50n);
    expect(l.getAccount(ALICE).balances[A]).toEqual({ available: ETH - ETH / 50n - 400n, pending: 0n });
    expect(l.earningValue(ALICE, A, ETH / 50n)).toBe(ETH / 50n);
  });

  it("prices a later supply at the pool's value, so earlier savers keep the interest they earned", () => {
    const l = setup();
    fund(l);
    l.completeEarn(l.requestSupply(ALICE, A, 1000n, 0n).id, 0n, 1000n);
    // The pool earned 10% before Bob joined; his 1000 lands on top of 1100.
    l.completeEarn(l.requestSupply(BOB, A, 1000n, 0n).id, 0n, 2100n);
    expect(l.earningValue(ALICE, A, 2100n)).toBe(1100n);
    expect(l.earningValue(BOB, A, 2100n)).toBe(999n); // rounding favors the pool, never the newcomer
  });

  it("redeems part or all of a position, keeping the shares out of reach until it confirms", () => {
    const l = setup();
    fund(l);
    l.completeEarn(l.requestSupply(ALICE, A, 1000n, 0n).id, 0n, 1000n);
    const part = l.requestRedeem(ALICE, A, 400n, 1000n);
    expect(l.earningValue(ALICE, A, 1000n)).toBe(600n);
    expect(() => l.requestRedeem(ALICE, A, 700n, 1000n)).toThrow(/more than you have earning/);
    l.completeEarn(part.id, 50n, 1000n);
    expect(l.getAccount(ALICE).balances[A].available).toBe(ETH - 1000n + 400n - 50n);
    const rest = l.requestRedeem(ALICE, A, "all", 600n);
    expect(rest.amount).toBe(600n);
    l.completeEarn(rest.id, 0n, 600n);
    expect(l.totalShares(A)).toBe(0n);
  });

  it("gives everything back when an earn operation fails, less any fee really paid", () => {
    const l = setup();
    fund(l);
    const s = l.requestSupply(ALICE, A, 1000n, 100n);
    l.failEarn(s.id, "refused");
    expect(l.getAccount(ALICE).balances[A]).toEqual({ available: ETH, pending: 0n });
    l.completeEarn(l.requestSupply(ALICE, A, 1000n, 0n).id, 0n, 1000n);
    const r = l.requestRedeem(ALICE, A, "all", 1000n);
    l.approvalConfirmed(r.id, 30n);
    l.failEarn(r.id, "reverted", 20n);
    expect(l.earningValue(ALICE, A, 1000n)).toBe(1000n);
    expect(l.getAccount(ALICE).balances[A].available).toBe(ETH - 1000n - 50n);
  });
});
