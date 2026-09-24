/**
 * Where the app's three Turnkey keys come from (vault admin, vault signer, sign-up).
 *
 * In ROFL: ROFL's key service (rofl-appd). Each key is derived for this app ID inside the attested enclave. It is the
 * same after every restart, upgrade, or move to another machine, and it never leaves the enclave: no file, no log.
 * On a laptop: random keys kept in files beside STATE_PATH (throwaway, like everything on a laptop).
 */
import { request } from "node:http";
import { existsSync } from "node:fs";
import { apiKeyFromRaw, loadOrCreateAppKeys, type ApiKeyPair } from "./turnkey.js";
import { loadOrCreateSignupKey } from "../auth/google.js";

export const APPD_SOCKET = process.env.ROFL_APPD_SOCKET ?? "/run/rofl-appd.sock";
export const inRofl = () => existsSync(APPD_SOCKET);

// NEXT PERSON: these names ARE the keys. Renaming one makes a different key, and the vault it guarded can never
// sign again. Add new names; never change these.
const KEY_IDS = { admin: "crossroads.turnkey.vault-admin.v1", signer: "crossroads.turnkey.vault-signer.v1", signup: "crossroads.turnkey.signup.v1" } as const;

export interface AppKeySet {
  admin: ApiKeyPair;
  signer: ApiKeyPair;
  signup: ApiKeyPair;
  /** rofl: from the enclave's key service. file: laptop files. */
  source: "rofl" | "file";
}

function appd(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: APPD_SOCKET, path, method, headers: { "content-type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ((res.statusCode ?? 500) < 300 ? resolve(data) : reject(new Error(`rofl-appd ${path}: ${res.statusCode} ${data.slice(0, 200)}`))));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** This app's ROFL app ID, or undefined outside ROFL. */
export async function roflAppId(): Promise<string | undefined> {
  if (!inRofl()) return undefined;
  return (await appd("GET", "/rofl/v1/app/id")).trim();
}

async function roflKey(keyId: string): Promise<ApiKeyPair> {
  const { key } = JSON.parse(await appd("POST", "/rofl/v1/keys/generate", { key_id: keyId, kind: "raw-256" })) as { key: string };
  return apiKeyFromRaw(Buffer.from(key.replace(/^0x/, ""), "hex"));
}

export async function loadAppKeys(dir: string): Promise<AppKeySet> {
  if (inRofl()) {
    return { admin: await roflKey(KEY_IDS.admin), signer: await roflKey(KEY_IDS.signer), signup: await roflKey(KEY_IDS.signup), source: "rofl" };
  }
  const { admin, signer } = loadOrCreateAppKeys(dir);
  return { admin, signer, signup: loadOrCreateSignupKey(dir), source: "file" };
}
