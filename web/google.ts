/**
 * Continue with Google, and signing with the user's own Turnkey wallet.
 *
 * 1. The browser makes a session key that cannot be copied out of it (kept in IndexedDB by Turnkey's stamper).
 * 2. Google's button is given nonce = sha256(the key's hex text), so Google's sign-in token names this key.
 * 3. The app hands the token to Turnkey, which checks it and opens a session for this key.
 * 4. Every request is then signed by the user's wallet: the page asks Turnkey directly, stamped with the session key.
 */
import { IndexedDbStamper } from "@turnkey/indexed-db-stamper";
import { TurnkeyClient } from "@turnkey/http";
import { getAddress, hashMessage, serializeSignature, type Hex } from "viem";
import type { RequestSigner } from "./signer.js";

const TURNKEY_API = "https://api.turnkey.com";
const SESSION_KEY = "crossroads.google.session";

export interface GoogleSession {
  organizationId: string;
  address: string;
  name: string;
  session: string;
  expiresAt: number;
}

let stamper: IndexedDbStamper | null = null;
async function sessionStamper(): Promise<IndexedDbStamper> {
  if (!stamper) {
    stamper = new IndexedDbStamper();
    await stamper.init();
  }
  return stamper;
}

/** The nonce Google must put in its token for Turnkey to accept it with this session key. */
// NEXT PERSON: Turnkey hashes the key's hex text, not its bytes. Hashing bytes gives a token Turnkey refuses.
export async function nonceFor(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicKey));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A brand-new session key for this sign-in, and the nonce that binds Google's token to it. */
export async function newSessionKey(): Promise<{ publicKey: string; nonce: string }> {
  const s = await sessionStamper();
  await s.resetKeyPair();
  const publicKey = s.getPublicKey();
  if (!publicKey) throw new Error("This browser could not make a session key");
  return { publicKey, nonce: await nonceFor(publicKey) };
}

export const googleSession = {
  current(): GoogleSession | null {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as GoogleSession | null;
      return s && s.expiresAt > Date.now() + 60_000 ? s : null;
    } catch {
      return null;
    }
  },
  save(s: GoogleSession) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* this tab still works; a reload asks for Google again */
    }
  },
  async clear() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* nothing saved */
    }
    await (await sessionStamper()).clear();
  },
};

/** Signs each request with the user's Turnkey wallet: one Turnkey signature, no pop-up. */
export function turnkeySigner(s: GoogleSession): RequestSigner {
  const signer: RequestSigner = {
    address: s.address,
    description: "your Turnkey wallet",
    async signMessage(message: string): Promise<Hex> {
      const client = new TurnkeyClient({ baseUrl: TURNKEY_API }, await sessionStamper());
      const t0 = performance.now();
      const res = await client.signRawPayload({
        type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
        timestampMs: String(Date.now()),
        organizationId: s.organizationId,
        // NEXT PERSON: the ledger keeps addresses lowercase, but Turnkey only finds the wallet by its checksummed form.
        parameters: { signWith: getAddress(s.address), payload: hashMessage(message), encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" },
      });
      const sig = res.activity.result.signRawPayloadResult;
      if (res.activity.status !== "ACTIVITY_STATUS_COMPLETED" || !sig) throw new Error(`Turnkey did not sign (${res.activity.status})`);
      signer.lastActivity = { id: res.activity.id, ms: Math.round(performance.now() - t0) };
      return signatureFromTurnkey(sig);
    },
  };
  return signer;
}

/** Turnkey returns r, s and v as bare hex, with v as 00 or 01; Ethereum signatures use 27 or 28. */
export function signatureFromTurnkey(sig: { r: string; s: string; v: string }): Hex {
  const bare = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
  return serializeSignature({ r: `0x${bare(sig.r)}`, s: `0x${bare(sig.s)}`, v: BigInt(parseInt(sig.v, 16) + 27) });
}

// ---------- Google's button ----------

interface GoogleId {
  initialize(cfg: { client_id: string; nonce: string; callback: (r: { credential: string }) => void; use_fedcm_for_button?: boolean }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

let gsiLoaded: Promise<void> | null = null;
function loadGoogleScript(): Promise<void> {
  gsiLoaded ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://accounts.google.com/gsi/client";
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      gsiLoaded = null;
      reject(new Error("Could not load Google sign-in. Check the connection and reload."));
    };
    document.head.appendChild(el);
  });
  return gsiLoaded;
}

/** Draws Continue with Google into `el`. `onToken` receives Google's sign-in token and the session key it names. */
export async function renderGoogleButton(el: HTMLElement, clientId: string, theme: "light" | "dark", onToken: (oidcToken: string, publicKey: string) => void) {
  const [{ publicKey, nonce }] = await Promise.all([newSessionKey(), loadGoogleScript()]);
  const gid = window.google?.accounts.id;
  if (!gid) throw new Error("Google sign-in did not start");
  gid.initialize({ client_id: clientId, nonce, callback: (r) => onToken(r.credential, publicKey) });
  gid.renderButton(el, { type: "standard", theme: theme === "dark" ? "filled_black" : "outline", size: "large", text: "continue_with", shape: "pill", width: 280 });
}
