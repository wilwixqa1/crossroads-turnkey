import { sepolia, baseSepolia, type Chain } from "viem/chains";
import type { Asset } from "../ledger/ledger.js";

export interface ChainConfig {
  asset: Asset;
  chain: Chain;
  /** Independent RPC endpoints. The first scans, the others cross-check. Need at least 2. */
  rpcUrls: string[];
  /** Blocks behind the tip before a deposit is credited. */
  confirmations: number;
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
    rpcUrls: urls("SEPOLIA_RPC_URLS", ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org"]),
    confirmations: Number(process.env.SEPOLIA_CONFIRMATIONS ?? 3),
    explorerTx: (h) => `https://sepolia.etherscan.io/tx/${h}`,
  },
  {
    asset: "ETH_BASE_SEPOLIA",
    chain: baseSepolia,
    rpcUrls: urls("BASE_SEPOLIA_RPC_URLS", ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"]),
    confirmations: Number(process.env.BASE_SEPOLIA_CONFIRMATIONS ?? 10),
    explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
];

export function chainFor(asset: Asset): ChainConfig {
  const c = CHAINS.find((x) => x.asset === asset);
  if (!c) throw new Error(`No chain for ${asset}`);
  return c;
}
