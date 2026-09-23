/**
 * Who signs the user's requests.
 *
 * Every ledger action is a plain-text message the user's own wallet signs. The page
 * only talks to RequestSigner, so Phase 2b swaps the stand-in below for a Turnkey
 * embedded wallet (passkey approval) without touching the rest of the page.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export interface RequestSigner {
  /** The account ID on the ledger. */
  readonly address: string;
  /** How the page describes this signer, e.g. "your stand-in key". */
  readonly description: string;
  signMessage(message: string): Promise<Hex>;
}

export interface StandInAccount {
  name: string;
  address: string;
  privateKey: Hex;
}

const LIST_KEY = "crossroads.standin.accounts";
const CURRENT_KEY = "crossroads.standin.current";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing: the session still works, it just is not remembered */
  }
}

/** Stand-in login: a test key generated and kept in this browser. Test funds only. */
export const standIn = {
  list(): StandInAccount[] {
    return read<StandInAccount[]>(LIST_KEY, []);
  },
  create(name: string): StandInAccount {
    const privateKey = generatePrivateKey();
    const acct: StandInAccount = { name, address: privateKeyToAccount(privateKey).address.toLowerCase(), privateKey };
    write(LIST_KEY, [...this.list(), acct]);
    return acct;
  },
  current(): StandInAccount | null {
    const addr = read<string | null>(CURRENT_KEY, null);
    return this.list().find((a) => a.address === addr) ?? null;
  },
  setCurrent(addr: string | null) {
    write(CURRENT_KEY, addr);
  },
  signer(acct: StandInAccount): RequestSigner {
    const key = privateKeyToAccount(acct.privateKey);
    return {
      address: acct.address,
      description: "your stand-in key",
      signMessage: (message) => key.signMessage({ message }),
    };
  },
};
