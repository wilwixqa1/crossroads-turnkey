/**
 * Persist the ledger to disk after every change.
 *
 * On a laptop this is ./data. In ROFL the same path is the app's encrypted
 * persistent volume, so the ledger survives restarts and upgrades.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
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

/**
 * Replace a file so that a machine stopping at any moment leaves either the old or the new contents, never a mix.
 * The data is flushed to disk before the rename, and the rename before returning.
 */
// NEXT PERSON: keep both fsyncs. On Sept 29, 2026 a redeploy restarted the ROFL machine and the saved ledger came
// back as a file of zero bytes (the rename reached the disk before the data did), so the app could not start.
export function writeFileDurably(path: string, data: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

function parse(path: string): AppState {
  return JSON.parse(readFileSync(path, "utf8"), reviver) as AppState;
}

/**
 * The saved state, or null on a first start. If the newest copy cannot be read, the one before it is used (at most
 * one change behind); if neither can be read, this throws rather than start with an empty ledger unnoticed.
 */
export function loadState(path: string): AppState | null {
  const prev = `${path}.prev`;
  if (!existsSync(path)) return existsSync(prev) ? parse(prev) : null;
  try {
    return parse(path);
  } catch (err) {
    if (!existsSync(prev)) throw new Error(`The saved state at ${path} cannot be read (${(err as Error).message.slice(0, 80)}) and there is no earlier copy`);
    console.warn(`The saved state at ${path} cannot be read; using the copy saved one change earlier`);
    return parse(prev);
  }
}

export function saveState(path: string, state: AppState) {
  // Keep the last good copy beside the new one, so one bad write never loses the ledger.
  if (existsSync(path)) {
    try {
      parse(path);
      renameSync(path, `${path}.prev`);
    } catch {
      /* the current copy is unreadable: keep the older .prev */
    }
  }
  writeFileDurably(path, JSON.stringify(state, replacer, 2));
}
