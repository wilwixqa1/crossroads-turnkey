/**
 * Persist the ledger to disk after every change.
 *
 * On a laptop this is ./data. In ROFL the same path is the app's encrypted
 * persistent volume, so the ledger survives restarts and upgrades.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerState } from "../ledger/ledger.js";

export interface AppState {
  ledger: LedgerState;
  /** Last block scanned per asset, so restarts resume where they stopped. */
  scanCursor: Record<string, string>;
  version: 1;
}

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? { $big: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === "object" && "$big" in (v as Record<string, unknown>) ? BigInt((v as { $big: string }).$big) : v;

export function loadState(path: string): AppState | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"), reviver) as AppState;
}

export function saveState(path: string, state: AppState) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, replacer, 2));
  renameSync(tmp, path); // atomic replace so a crash mid-write cannot corrupt the file
}
