/**
 * Aave v3 on Base Sepolia: where the vault earns on pooled funds (Earn tab).
 *
 * The vault supplies native ETH through Aave's WETH gateway (one call, one signature) and takes it back the same way
 * (approve the gateway to take the aWETH back, then withdraw). It never borrows: the vault signer's Turnkey policies
 * allow only these calls, on the vault's own behalf, and explicitly deny every way to open debt.
 *
 * Base Sepolia, not Sepolia: on Sept 28, 2026 Aave's Sepolia WETH market paid 0% (nobody borrowing), Base Sepolia's
 * about 2.3% a year, so only there does an Earning balance visibly grow.
 * Addresses from Aave's official address book (github.com/bgd-labs/aave-address-book, AaveV3BaseSepolia.sol).
 */
import { parseAbi, type Address } from "viem";
import type { Asset } from "../ledger/ledger.js";

export interface AaveMarket {
  asset: Asset;
  chainId: number;
  /** Network name, for policy names and labels. */
  name: string;
  /** The Pool: holds supplied funds and is where borrowing would happen. */
  pool: Address;
  /** WrappedTokenGatewayV3: supplies and withdraws native ETH in one call. */
  gateway: Address;
  weth: Address;
  /** aWETH: the vault's receipt for supplied ETH; its balance grows with interest. */
  aWeth: Address;
  /** Variable-debt WETH: approving delegation on it would let someone else borrow against the vault's supply. */
  vDebt: Address;
}

export const AAVE_MARKETS: AaveMarket[] = [
  {
    asset: "ETH_BASE_SEPOLIA",
    chainId: 84532,
    name: "Base Sepolia",
    pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
    gateway: "0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6",
    weth: "0x4200000000000000000000000000000000000006",
    aWeth: "0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb",
    vDebt: "0x562abf6562d6A2b165aDa02b5946bc3E7b4dD653",
  },
];

export function aaveMarket(asset: Asset): AaveMarket | undefined {
  return AAVE_MARKETS.find((m) => m.asset === asset);
}

/**
 * Only the functions the vault's rules talk about. Turnkey decodes calls with these (uploaded as smart contract
 * interfaces), so a policy can name the function and its arguments.
 */
export const GATEWAY_ABI = parseAbi([
  "function depositETH(address pool, address onBehalfOf, uint16 referralCode) payable",
  "function withdrawETH(address pool, uint256 amount, address to)",
  "function borrowETH(address pool, uint256 amount, uint16 referralCode)",
]);

export const POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function flashLoan(address receiverAddress, address[] assets, uint256[] amounts, uint256[] interestRateModes, address onBehalfOf, bytes params, uint16 referralCode)",
  "function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes params, uint16 referralCode)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

export const DEBT_TOKEN_ABI = parseAbi(["function approveDelegation(address delegatee, uint256 amount)", "function balanceOf(address owner) view returns (uint256)"]);

/** Aave quotes its supply rate as a yearly rate in ray (1e27). This is that rate as a percentage, two decimals. */
export function supplyRatePercent(currentLiquidityRate: bigint): number {
  return Number((currentLiquidityRate * 10_000n) / 10n ** 27n) / 100;
}
