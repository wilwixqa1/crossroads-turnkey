# Backlog

Actionable work only, roughly in order. Facts that are not work live as comments in the code where the next person would be standing (see docs/WORKFLOW.md).

## Next up

- [ ] Deploy once, a day before the call (needs about 200 TEST in the deploy wallet 0xd3bac6427A4702aCb3d6Ae3107402BE223c924C3; it holds 19.9 on Sept 28; 5 TEST per hour). The machine lapsed on Sept 26, so the deploy rents a new one with a new address: Will adds it to the Google client's Authorized JavaScript origins. On first start the app updates the live vault's rules: four per-network withdrawal rules replace the old two, four Aave rules and four contract interfaces are added. These exact rules were checked on a throwaway vault with `npm run turnkey:rules` (free). If Turnkey still refuses them, the vault keeps its old rules and the proof page shows the problem.
- [ ] Live run on the new machine (Will):
  1. sign in as William Wendt: he gets vault address #0 back and his 0.1 Sepolia ETH is credited again by its transaction, automatically (RESTORE_ACCOUNTS in compose.yaml); sign in as wil wix (gets #1 back);
  2. send wil wix 0.01 by account ID or deposit address;
  3. withdraw 0.01 Sepolia ETH to MetaMask: the first vault-signed withdrawal on a real network, watch it end to end;
  4. an over-limit withdrawal (0.06 on Sepolia or 0.03 on Base Sepolia): refused by that network's rule;
  5. deposit about 0.1 Base Sepolia ETH (MetaMask holds 0.15), seed the swap pool with both assets (Add liquidity, William only), one swap;
  6. Earn: start with 0.02 Base ETH, watch Earning tick, then Stop all (first stop takes two vault signatures: approve, then withdraw);
  7. proof page: all five live checks refused, solvency Covered on both networks.
- [ ] Recorded rehearsal (the backup if anything fails live), then keep the machine topped up through the call (5 TEST per hour, about 120 per day).
- [ ] Billing check (Will): Turnkey's usage page. Roughly 6 completed signatures before T04, plus 1 in T04 (the throwaway-vault check that a withdrawal still signs alongside the Aave rules); refusals do not count. The full run, rehearsal and call need roughly 5 to 7 each, so add the pay-as-you-go card before the rehearsal.

## Later / optional

- [ ] On-chain swaps from the vault through Uniswap v3 (SwapRouter02: Sepolia 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E, Base Sepolia 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4), with an ABI-scoped policy. Needs ERC-20 support in the ledger first; testnet liquidity is thin. A talking point for the call, not a build item before it.
- [ ] Lock the vault (tested on a throwaway vault in T03; Will chose to wait): signer gets permission to add deposit addresses, a second root user with a discarded key, root quorum 2. Build it as a setting that is off by default, run once from inside the app; switch deposit-address creation to the signer. Irreversible.
- [ ] A spending limit over time on the vault (Turnkey lists a velocity-control activity; untested). This, not the per-withdrawal cap, is the production answer to a bad upgrade draining the vault.
- [ ] Account data readable only by the account's own wallet (today anyone with an account ID can read its balances and history).
- [ ] A keyed network provider (Alchemy, free) as the primary, public ones as second opinions.
- [ ] Withdraw from a vault address other than the user's own, to break the deposit-to-withdrawal link on-chain.
- [ ] Tidy Will's Turnkey org (his call): Test_Policy and the CryptoSwim test user. Five old test sub-orgs cannot be deleted or renamed by anyone, since only a sub-org's own root key can and those keys were discarded: T02 vault b27be120, T03 local-test vault db7ddd37, browser checks 15cda38f and c650228a, sealed test vault aa1cb620. All hold nothing (checked Sept 28). Turnkey support may be able to remove them. The T04 rules-check vault was deleted.
- [ ] Send by email (Will's call, open): lookup reveals only the recipient's display name, and only during a real send.
- [ ] Solana as a third asset (one vault address plus a policy).
- [ ] Rebalancing between vault addresses when one runs short.
- [ ] A withdrawal whose transaction is dropped stays locked until a later withdrawal uses the same vault address; add a rebroadcast or timeout if it ever happens in practice.
- [ ] Under the hood history lives in memory and clears on restart; persist it if rehearsals need it.
- [ ] Reading the live machine's logs from the workspace: `oasis rofl machine logs` asks for a passphrase interactively and fails with EOF. Find the non-interactive form if logs are needed.

## Done

- [x] T04 (Sept 28): expired Google sign-in returns to Continue with Google; Send checks the recipient before signing and accepts a deposit address; dashboard-style activity IDs; restore of earlier deposit addresses and deposits after a machine move; per-network limits (0.05 Sepolia, 0.02 Base Sepolia) with withdrawals limited to plain ETH transfers (21,000 gas); withdrawals to contracts or smart accounts refused before signing; Base's L1 data fee charged; proof page with five live checks; Earn on Base Sepolia (Sepolia's WETH market paid 0%): pooled Aave supply with per-user shares, never-borrow rule; every rule checked on real Turnkey (a throwaway vault, deleted afterwards). 60 tests.

- [x] T03 (Sept 24): GitHub Actions deploys (deploy / top-up / status) and Crossroads live on ROFL testnet; one Withdraw button; Google sign-in (one Turnkey wallet per user, browser session key signs each request); Phase 3: keys from ROFL's key service, the app creates its own Turnkey vault with its sign-up key and finds it again by its admin key; real vault live; deposits no longer skipped when the second provider is down, plus crediting a missed deposit by its transaction; demo annotations (key names, activity IDs, policy names, "What just happened" card); vault lock tested on a throwaway vault. 35 tests.

- [x] T02 (Sept 23-24): trading page with stand-in login; fixed deposits never being credited on a fresh start; withdrawals stay locked when a broadcast errors; stand-in vault makes its own key phrase. Phase 1: Turnkey vault in Will's org (sub-organization with the app's admin key as sole root, vault wallet, signer limited to Sepolia and Base Sepolia up to 0.05 ETH, deny above 0.05 ETH); live checks passed; parent org can read the vault but cannot sign. Decisions for T03: Google sign-in, one Withdraw button, GitHub Actions deploys; SoW updated to match (rev 65). 26 tests.

- [x] T01 (Sept 23): repo, ledger with tests, signed requests with sequence numbers, EVM deposit scanning with two-provider check, withdrawal flow, stand-in vault, server skeleton, SoW snapshot, workflow docs, CI.
