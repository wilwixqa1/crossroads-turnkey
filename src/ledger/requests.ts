/**
 * Signed user requests.
 *
 * Every ledger action (transfer, swap, withdraw, add liquidity) is a message the
 * user's own wallet key signs. The server verifies the signature against the
 * account id (an Ethereum-style address) and enforces the sequence number.
 *
 * The message is plain text so a wallet shows it readably. It works the same
 * whether the key is a stand-in local key, MetaMask, or a Turnkey user wallet
 * signing with a passkey approval.
 */
import { verifyMessage, type Hex } from "viem";

export type RequestAction = "transfer" | "swap" | "withdraw" | "add_liquidity";

export interface SignedRequest {
  account: string;
  seq: number;
  action: RequestAction;
  params: Record<string, string>;
  signature: Hex;
}

/** Canonical text the user signs. Keys sorted so client and server agree byte for byte. */
export function requestMessage(account: string, seq: number, action: RequestAction, params: Record<string, string>): string {
  const lines = [
    "Crossroads Demo",
    `account: ${account.toLowerCase()}`,
    `seq: ${seq}`,
    `action: ${action}`,
  ];
  for (const k of Object.keys(params).sort()) lines.push(`${k}: ${params[k]}`);
  return lines.join("\n");
}

export async function verifyRequest(req: SignedRequest): Promise<void> {
  const message = requestMessage(req.account, req.seq, req.action, req.params);
  const ok = await verifyMessage({ address: req.account as Hex, message, signature: req.signature });
  if (!ok) throw new Error("Bad signature");
}
