# Backlog

Actionable work only, roughly in order. Facts that are not work live as comments in the code where the next person would be standing (see docs/WORKFLOW.md).

## Next up

- [ ] Finish the first live run (Will, on the ROFL address; the 0.07 refusal is done and found in the vault's Activities):
  1. sign in as wil wix once (that account is not in the fresh ledger yet);
  2. as William Wendt, send wil wix 0.01;
  3. withdraw 0.01 Sepolia ETH to MetaMask. A successful vault-signed withdrawal has not run on a real network yet; watch it end to end.
- [ ] Per-network withdrawal limits (decided): 0.05 ETH on Sepolia, 0.02 ETH on Base Sepolia. One limit per network in settings; the Withdraw form shows the selected network's limit; on start the app (vault admin, not locked) replaces the vault's limit policies with per-network ones. No Will key needed. Update the policy-name text the page shows.
- [ ] Proof page (Phase 5), linked from the header:
  - code version: ROFL app ID, enclave identity and image digest from the committed manifest, explorer link;
  - key control, read live from Turnkey: the vault's users, root quorum, policies; the sign-up user's one policy;
  - solvency: on-chain vault balances against ledger totals;
  - signing history: the vault's Turnkey activities;
  - live checks, each showing Turnkey's refusal and its activity ID: vault signer tries to export the wallet; vault signer tries another network (e.g. mainnet); sign-up key tries to add a policy or sign with Will's own wallet (shows in the main org's log); replay of a used request (Crossroads' own check). Confirm the export refusal on a throwaway vault first. Never demo anything with the vault admin: it is root and would succeed.
- [ ] Base Sepolia and swaps (Phase 4): needs about 0.1 Base Sepolia ETH from Will, LIQUIDITY_PROVIDER set to his account ID in the live settings (added liquidity cannot be withdrawn), pool seeding, one real end-to-end check.
- [ ] Recorded rehearsal (the backup if anything fails live), then keep the machine topped up through the call (5 TEST per hour, about 120 per day).
- [ ] Billing check (Will): Turnkey's usage page. Expected roughly 5 completed signatures so far (2 in T02; in T03 the browser signing check, the seal test's 0.01, and the request behind Will's refused 0.07); refusals should not count.

## Later / optional

- [ ] Lock the vault (tested on a throwaway vault in T03; Will chose to wait): signer gets permission to add deposit addresses, a second root user with a discarded key, root quorum 2. Build it as a setting that is off by default, run once from inside the app; switch deposit-address creation to the signer. Irreversible.
- [ ] A spending limit over time on the vault (Turnkey lists a velocity-control activity; untested). This, not the per-withdrawal cap, is the production answer to a bad upgrade draining the vault.
- [ ] Account data readable only by the account's own wallet (today anyone with an account ID can read its balances and history).
- [ ] A keyed network provider (Alchemy, free) as the primary, public ones as second opinions.
- [ ] Withdraw from a vault address other than the user's own, to break the deposit-to-withdrawal link on-chain.
- [ ] Tidy Will's Turnkey org (his call): Test_Policy, throwaway sub-orgs (T02 vault, T03 local-test vault, two browser-signing checks, the sealed test vault), the CryptoSwim test user.
- [ ] Solana as a third asset (one vault address plus a policy).
- [ ] Rebalancing between vault addresses when one runs short.
- [ ] A withdrawal whose transaction is dropped stays locked until a later withdrawal uses the same vault address; add a rebroadcast or timeout if it ever happens in practice.
- [ ] Under the hood history lives in memory and clears on restart; persist it if rehearsals need it.
- [ ] Reading the live machine's logs from the workspace: `oasis rofl machine logs` asks for a passphrase interactively and fails with EOF. Find the non-interactive form if logs are needed.

## Done

- [x] T03 (Sept 24): GitHub Actions deploys (deploy / top-up / status) and Crossroads live on ROFL testnet; one Withdraw button; Google sign-in (one Turnkey wallet per user, browser session key signs each request); Phase 3: keys from ROFL's key service, the app creates its own Turnkey vault with its sign-up key and finds it again by its admin key; real vault live; deposits no longer skipped when the second provider is down, plus crediting a missed deposit by its transaction; demo annotations (key names, activity IDs, policy names, "What just happened" card); vault lock tested on a throwaway vault. 35 tests.

- [x] T02 (Sept 23-24): trading page with stand-in login; fixed deposits never being credited on a fresh start; withdrawals stay locked when a broadcast errors; stand-in vault makes its own key phrase. Phase 1: Turnkey vault in Will's org (sub-organization with the app's admin key as sole root, vault wallet, signer limited to Sepolia and Base Sepolia up to 0.05 ETH, deny above 0.05 ETH); live checks passed; parent org can read the vault but cannot sign. Decisions for T03: Google sign-in, one Withdraw button, GitHub Actions deploys; SoW updated to match (rev 65). 26 tests.

- [x] T01 (Sept 23): repo, ledger with tests, signed requests with sequence numbers, EVM deposit scanning with two-provider check, withdrawal flow, stand-in vault, server skeleton, SoW snapshot, workflow docs, CI.
