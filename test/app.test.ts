import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEther, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { App } from "../src/app.js";
import { LocalVault } from "../src/signer/index.js";
import { requestMessage, type RequestAction } from "../src/ledger/requests.js";
import type { Asset } from "../src/ledger/ledger.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const CAP = parseEther("0.05");
const OUTSIDE = "0x9999999999999999999999999999999999999999";

type Fake = Record<string, (...args: any[]) => Promise<unknown>>;

function notFound(): never {
  const e = new Error("receipt not found");
  e.name = "TransactionReceiptNotFoundError";
  throw e;
}

/** A stand-in network provider. Each test overrides only what it cares about. */
function fakeClient(over: Fake = {}): Fake {
  return {
    getBlockNumber: async () => 1000n,
    getTransactionCount: async () => 0,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    getBalance: async () => parseEther("1"),
    sendRawTransaction: async () => "0x",
    getTransactionReceipt: async () => notFound(),
    getBlock: async () => ({ transactions: [] }),
    ...over,
  };
}

let dir: string;
let app: App;

function build(opts: { liquidityProvider?: string } = {}) {
  app = new App(new LocalVault(MNEMONIC, [], CAP), join(dir, "state.json"), opts);
  return app;
}

function useClients(asset: Asset, primary: Fake, secondary: Fake = fakeClient()) {
  const chain = app.chains.get(asset)!;
  chain.clients[0] = primary as unknown as PublicClient;
  chain.clients[1] = secondary as unknown as PublicClient;
}

async function user(name: string) {
  const key = privateKeyToAccount(generatePrivateKey());
  const acct = await app.signUp(key.address, name);
  let seq = 1;
  return {
    id: acct.id,
    depositAddress: acct.depositAddress,
    async send(action: RequestAction, params: Record<string, string>, useSeq = seq) {
      const signature = await key.signMessage({ message: requestMessage(key.address, useSeq, action, params) });
      seq = useSeq + 1;
      return app.handleRequest({ account: key.address, seq: useSeq, action, params, signature });
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crossroads-"));
});
afterEach(() => {
  App.DROP_GRACE_MS = 5 * 60_000;
  rmSync(dir, { recursive: true, force: true });
});

describe("signed requests through the app", () => {
  it("settles a transfer instantly, reports how long it took, and refuses a replay", async () => {
    build();
    const alice = await user("Alice");
    const bob = await user("Bob");
    app.ledger.creditDeposit("ETH_SEPOLIA", "0xd1", alice.depositAddress, parseEther("0.1"));
    const params = { to: bob.id, asset: "ETH_SEPOLIA", amount: parseEther("0.01").toString() };
    const res = await alice.send("transfer", params);
    expect(typeof res.settledMs).toBe("number");
    expect(app.ledger.getAccount(bob.id).balances.ETH_SEPOLIA.available).toBe(parseEther("0.01"));
    const event = app.ledger.eventsFor(bob.id).find((e) => e.kind === "transfer")!;
    expect(event.detail.settledMs).toBe(res.settledMs);
    await expect(alice.send("transfer", params, 1)).rejects.toThrow(/sequence/);
  });

  it("lets only the configured liquidity provider add to the pool", async () => {
    build();
    const alice = await user("Alice");
    const bob = await user("Bob");
    app.opts.liquidityProvider = alice.id;
    for (const u of [alice, bob]) app.ledger.creditDeposit("ETH_SEPOLIA", `0x${u.id.slice(2, 8)}`, u.depositAddress, parseEther("0.1"));
    const params = { asset: "ETH_SEPOLIA", amount: parseEther("0.05").toString() };
    await expect(bob.send("add_liquidity", params)).rejects.toThrow(/liquidity provider/);
    await alice.send("add_liquidity", params);
    expect(app.ledger.state.pool.reserves.ETH_SEPOLIA).toBe(parseEther("0.05"));
  });
});

describe("withdrawals", () => {
  it("an over-limit withdrawal is locked, reaches the vault, is refused there, and the funds come back", async () => {
    build();
    useClients("ETH_SEPOLIA", fakeClient());
    const alice = await user("Alice");
    app.ledger.creditDeposit("ETH_SEPOLIA", "0xd1", alice.depositAddress, parseEther("0.1"));
    const params = { asset: "ETH_SEPOLIA", amount: parseEther("0.06").toString(), destination: OUTSIDE };
    await alice.send("withdraw", params);
    expect(app.ledger.getAccount(alice.id).balances.ETH_SEPOLIA.pending).toBeGreaterThan(0n);
    await app.processWithdrawals();
    const acct = app.ledger.getAccount(alice.id);
    expect(acct.balances.ETH_SEPOLIA).toEqual({ available: parseEther("0.1"), pending: 0n });
    expect(Object.values(app.ledger.state.withdrawals)[0].status).toBe("failed");
    expect(app.hood.some((h) => h.source === "turnkey" && /refused to sign/.test(h.text))).toBe(true);
  });

  it("keeps funds locked when the broadcast errors, since the transaction may still land", async () => {
    build();
    useClients("ETH_SEPOLIA", fakeClient({ sendRawTransaction: async () => { throw new Error("timeout"); } }));
    const alice = await user("Alice");
    app.ledger.creditDeposit("ETH_SEPOLIA", "0xd1", alice.depositAddress, parseEther("0.1"));
    await alice.send("withdraw", { asset: "ETH_SEPOLIA", amount: parseEther("0.01").toString(), destination: OUTSIDE });
    await app.processWithdrawals();
    const w = Object.values(app.ledger.state.withdrawals)[0];
    expect(w.status).toBe("sent");
    expect(w.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(app.ledger.getAccount(alice.id).balances.ETH_SEPOLIA.pending).toBeGreaterThan(0n);
  });

  it("unlocks a withdrawal only once another transaction has used its slot", async () => {
    build();
    let mined = 0;
    const primary = fakeClient({
      sendRawTransaction: async () => { throw new Error("timeout"); },
      getTransactionCount: async (args: { blockTag: string }) => (args.blockTag === "latest" ? mined : 0),
    });
    useClients("ETH_SEPOLIA", primary);
    const alice = await user("Alice");
    app.ledger.creditDeposit("ETH_SEPOLIA", "0xd1", alice.depositAddress, parseEther("0.1"));
    await alice.send("withdraw", { asset: "ETH_SEPOLIA", amount: parseEther("0.01").toString(), destination: OUTSIDE });
    await app.processWithdrawals();
    App.DROP_GRACE_MS = 0;
    await app.processWithdrawals();
    expect(Object.values(app.ledger.state.withdrawals)[0].status).toBe("sent"); // slot not used yet: still locked
    mined = 1;
    await app.processWithdrawals();
    expect(Object.values(app.ledger.state.withdrawals)[0].status).toBe("failed");
    expect(app.ledger.getAccount(alice.id).balances.ETH_SEPOLIA).toEqual({ available: parseEther("0.1"), pending: 0n });
  });
});

describe("deposits", () => {
  it("shows a deposit as arriving at the tip, then credits it once confirmed by both providers", async () => {
    build();
    let head = 1000n;
    const blocks = new Map<bigint, unknown[]>();
    const primary = fakeClient({
      getBlockNumber: async () => head,
      getBlock: async (args: { blockNumber: bigint }) => ({ transactions: blocks.get(args.blockNumber) ?? [] }),
    });
    const alice = await user("Alice");
    const tx = { hash: "0xabc", to: alice.depositAddress, from: OUTSIDE, value: parseEther("0.02") };
    const secondary = fakeClient({
      getTransactionReceipt: async () => ({ status: "success" }),
      getTransaction: async () => tx,
    });
    useClients("ETH_SEPOLIA", primary, secondary);

    await app.pollDeposits("ETH_SEPOLIA"); // first run: remember where to start
    expect(app.scanCursor.ETH_SEPOLIA).toBe(997n);

    head = 1001n;
    blocks.set(1001n, [tx]);
    await app.pollDeposits("ETH_SEPOLIA");
    expect(app.incomingFor(alice.id)).toMatchObject([{ confirmations: 0, needed: 3 }]);
    expect(app.ledger.getAccount(alice.id).balances.ETH_SEPOLIA.available).toBe(0n);

    head = 1004n;
    await app.pollDeposits("ETH_SEPOLIA");
    expect(app.ledger.getAccount(alice.id).balances.ETH_SEPOLIA.available).toBe(parseEther("0.02"));
    expect(app.incomingFor(alice.id)).toEqual([]);
  });
});
