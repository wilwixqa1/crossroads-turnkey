/** Thin client for the app's JSON API. Every amount is a decimal string of wei. */
import type { Asset } from "../src/ledger/ledger.js";
import type { SignedRequest } from "../src/ledger/requests.js";

export type { Asset };

export interface ChainInfo {
  asset: Asset;
  chainId: number;
  name: string;
  confirmations: number;
  head: string | null;
}

export interface Status {
  mode: string;
  vault: string;
  vaultLabel: string;
  assets: Asset[];
  chains: ChainInfo[];
  withdrawalCap: string;
  liquidityProvider: string | null;
  pool: Record<Asset, string>;
  accounts: number;
  vaultReady: boolean;
  appKeys: { source: "rofl" | "file"; vaultAdmin: string; vaultSigner: string; signup: string } | null;
  roflAppId: string | null;
  login: { mode: "google" | "standin"; googleClientId: string | null; signupPublicKey: string | null; sessionSeconds: number };
}

export interface Balance {
  available: string;
  pending: string;
}

export interface FeedEvent {
  id: number;
  at: number;
  account?: string;
  kind: string;
  settlement: "instant" | "onchain";
  detail: Record<string, string | number>;
  fromName?: string;
  toName?: string;
  link?: string;
}

export interface WithdrawalView {
  id: string;
  asset: Asset;
  amount: string;
  feeReserved: string;
  destination: string;
  status: "pending" | "sent" | "complete" | "failed";
  txHash?: string;
  link?: string;
  error?: string;
  createdAt: number;
}

export interface IncomingView {
  asset: Asset;
  txHash: string;
  amount: string;
  confirmations: number;
  needed: number;
  link: string;
}

export interface AccountView {
  id: string;
  name: string;
  depositAddress: string;
  nextSeq: number;
  balances: Record<Asset, Balance>;
  events: FeedEvent[];
  withdrawals: WithdrawalView[];
  incoming: IncomingView[];
}

export interface HoodEntry {
  at: number;
  account?: string;
  text: string;
  link?: string;
  ms?: number;
  source: "turnkey" | "wallet" | "chain" | "ledger";
}

export class ApiError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, body.code ?? "ERROR");
  return body as T;
}

export const api = {
  status: () => call<Status>("/api/status"),
  account: (id: string) => call<AccountView>(`/api/accounts/${id}`),
  googleSignIn: (oidcToken: string, publicKey: string) =>
    call<{ organizationId: string; address: string; name: string; session: string; expiresAt: number; created: boolean }>("/api/auth/google", { method: "POST", body: JSON.stringify({ oidcToken, publicKey }) }),
  signUp: (id: string, name: string) => call<AccountView>("/api/accounts", { method: "POST", body: JSON.stringify({ id, name }) }),
  hood: (id: string) => call<HoodEntry[]>(`/api/hood?account=${encodeURIComponent(id)}`),
  quote: (assetIn: Asset, assetOut: Asset, amount: bigint) =>
    call<{ amountOut: string }>(`/api/quote?assetIn=${assetIn}&assetOut=${assetOut}&amount=${amount}`),
  request: (req: SignedRequest) => call<Record<string, unknown> & { settledMs?: number }>("/api/requests", { method: "POST", body: JSON.stringify(req) }),
};
