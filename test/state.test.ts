import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, type AppState } from "../src/storage/state.js";

let dir: string;
let path: string;
const state = (n: number): AppState => ({ ledger: { marker: BigInt(n) } as never, scanCursor: {}, version: 1 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crossroads-state-"));
  path = join(dir, "v1", "state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("saved state", () => {
  it("is null on a first start and reads back what was saved, big numbers included", () => {
    expect(loadState(path)).toBeNull();
    saveState(path, state(7));
    expect((loadState(path)!.ledger as unknown as { marker: bigint }).marker).toBe(7n);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("falls back to the copy one change earlier when the newest was zeroed by a restart", () => {
    saveState(path, state(1));
    saveState(path, state(2));
    writeFileSync(path, "\0".repeat(64)); // what the Sept 29 redeploy left behind
    expect((loadState(path)!.ledger as unknown as { marker: bigint }).marker).toBe(1n);
  });

  it("refuses to start with an empty ledger when no copy can be read", () => {
    saveState(path, state(1));
    writeFileSync(path, "\0".repeat(64));
    expect(() => loadState(path)).toThrow(/cannot be read.*no earlier copy/);
  });

  it("never replaces a good earlier copy with an unreadable one", () => {
    saveState(path, state(1));
    saveState(path, state(2));
    writeFileSync(path, "\0".repeat(64));
    saveState(path, state(3)); // the unreadable copy is not kept as the earlier one
    writeFileSync(path, "\0".repeat(64));
    expect((loadState(path)!.ledger as unknown as { marker: bigint }).marker).toBe(1n);
  });
});
