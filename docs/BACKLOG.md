# Backlog

Actionable work only, roughly in order. Facts that are not work live as comments in the code where the next person would be standing (see docs/WORKFLOW.md).

## Next up

- [ ] Phase 2 check on real testnets (Will, once he has test ETH): run on a laptop with the stand-in vault; deposit Sepolia ETH, send to a second account, withdraw to MetaMask.
- [ ] Phase 1 hands-on (Will): open the vault sub-organization in the Turnkey dashboard, look at its users, policies and wallet, and try to sign with it (it should not work). Check the usage page: 2 signatures used so far; the refused ones should not count.
- [ ] ROFL smoke test (Phase 0b): trivial container on ROFL testnet with a public URL, driven by Will with guidance.
- [ ] Passkey wallets (Phase 2b): sign-up/login, one sub-org per user, requests signed by the user's Turnkey wallet. The page's signer is already swappable (web/signer.ts); sign-up should also prove key ownership, since the stand-in sign-up call is unauthenticated.
- [ ] Move into ROFL (Phase 3): Dockerfile (must run `npm run build`, which bundles the page), rofl.yaml, secrets, persistent volume at STATE_PATH, keys from rofl-appd (feed their raw bytes to `apiKeyFromRaw`), redo vault setup with enclave keys. Setup today reads the app's keys from the local folder; for ROFL it must instead take the admin public key the running app shows, and the app bootstraps the rest itself on start.
- [ ] Base Sepolia and swaps (Phase 4): code and page done and tested on local chains; needs Will's pool seeding (set LIQUIDITY_PROVIDER to his account ID) and a real end-to-end check.
- [ ] Proof page (Phase 5): attestation, key control (live from Turnkey: the vault's users, root quorum, and the two policies), solvency, signing history, and a header link to it. Try to break it already lives on the Withdraw tab.

## Later / optional

- [ ] Solana as a third asset (one vault address plus a policy).
- [ ] Rebalancing between vault addresses when one runs short.
- [ ] Hook the Under the hood panel to Turnkey activity IDs once the vault is real.
- [ ] A withdrawal whose transaction is dropped stays locked until a later withdrawal uses the same vault address; add a rebroadcast or timeout if it ever happens in practice.
- [ ] Under the hood history lives in memory and clears on restart; persist it if rehearsals need it.

## Done

- [x] T03 (Sept 23): Phase 1. Turnkey vault in Will's org: sub-organization with the app's admin key as sole root, vault wallet, policy-limited signer (allow Sepolia and Base Sepolia from the vault wallet up to 0.05 ETH; deny above 0.05 ETH). Live checks passed: signer signs a small Sepolia withdrawal; Turnkey refuses over-cap and wrong-chain requests; parent org can read the vault but cannot sign. Turnkey accepts app keys built from raw bytes. Full page flow on local chains with Turnkey signing a real withdrawal and refusing Try to break it. 26 tests.

- [x] T02 (Sept 23): trading page with stand-in login (balances, Deposit/Swap/Send/Withdraw/Add liquidity, Try to break it, In flight with confirmation counts, activity feed, Under the hood, light and dark); fixed deposits never being credited on a fresh start; withdrawals stay locked when a broadcast errors; stand-in vault makes its own key phrase; 20 tests; full flow run on local chains posing as Sepolia and Base Sepolia.

- [x] T01 (Sept 23): repo, ledger with tests, signed requests with sequence numbers, EVM deposit scanning with two-provider check, withdrawal flow, stand-in vault, server skeleton, SoW snapshot, workflow docs, CI.
