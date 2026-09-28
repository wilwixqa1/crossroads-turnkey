import { parseEther } from "viem";
import { sepolia, baseSepolia, type Chain } from "viem/chains";
import type { Asset } from "../ledger/ledger.js";

export interface ChainConfig {
  asset: Asset;
  chain: Chain;
  /** Independent RPC endpoints. The first scans, the others cross-check. Need at least 2. */
  rpcUrls: string[];
  /** Blocks behind the tip before a deposit is credited. */
  confirmations: number;
  /**
   * The vault's per-withdrawal limit on this network, in wei. Only the vault enforces it (a Turnkey policy per network,
   * or the stand-in imitating it); the app has no limit of its own.
   */
  withdrawalCap: bigint;
  explorerTx: (hash: string) => string;
}

function urls(envName: string, fallback: string[]): string[] {
  const v = process.env[envName];
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

export const CHAINS: ChainConfig[] = [
  {
    asset: "ETH_SEPOLIA",
    chain: sepolia,
    // NEXT PERSON: rpc.sepolia.org stopped answering (Sept 2026). Providers after the first are tried in order for the
    // second opinion, so one dead provider no longer blocks deposits. A keyed provider (Alchemy etc.) is sturdier.
    rpcUrls: urls("SEPOLIA_RPC_URLS", ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co", "https://rpc.sepolia.ethpandaops.io"]),
    confirmations: Number(process.env.SEPOLIA_CONFIRMATIONS ?? 3),
    withdrawalCap: parseEther(process.env.SEPOLIA_WITHDRAWAL_CAP_ETH ?? "0.05"),
    explorerTx: (h) => `https://sepolia.etherscan.io/tx/${h}`,
  },
  {
    asset: "ETH_BASE_SEPOLIA",
    chain: baseSepolia,
    rpcUrls: urls("BASE_SEPOLIA_RPC_URLS", ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org", "https://base-sepolia.drpc.org"]),
    confirmations: Number(process.env.BASE_SEPOLIA_CONFIRMATIONS ?? 10),
    withdrawalCap: parseEther(process.env.BASE_SEPOLIA_WITHDRAWAL_CAP_ETH ?? "0.02"),
    explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
];

export function chainFor(asset: Asset): ChainConfig {
  const c = CHAINS.find((x) => x.asset === asset);
  if (!c) throw new Error(`No chain for ${asset}`);
  return c;
}

/** The vault's limits, one per network, in the form the vault's policies are built from. */
export function withdrawalLimits(chains: ChainConfig[] = CHAINS) {
  return chains.map((c) => ({ chainId: c.chain.id, name: c.chain.name, cap: c.withdrawalCap }));
}
