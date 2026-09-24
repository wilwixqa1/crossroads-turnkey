# Backlog

Actionable work only, roughly in order. Facts that are not work live as comments in the code where the next person would be standing (see docs/WORKFLOW.md).

## Next up

- [ ] Phase 2 check on real testnets (Will, once he has test ETH): run on a laptop with the stand-in vault; deposit Sepolia ETH, send to a second account, withdraw to MetaMask.
- [ ] Phase 1 hands-on (Will): open the vault sub-organization in the Turnkey dashboard, look at its users, policies and wallet, and try to sign with it (it should not work). Check the usage page: 2 signatures used so far; the refused ones should not count.
- [ ] Deploy via GitHub Actions (replaces local Phase 0b tooling): build image, push to ghcr.io, build the ROFL bundle with rofl-dev, `oasis rofl create/update/deploy` with a deploy wallet kept as a repo secret. Will funds that wallet with TEST from MetaMask. First deploy doubles as the smoke test.
- [ ] One Withdraw button: remove Try to break it and the app's own per-withdrawal cap so Turnkey's policy is the only limit.
- [ ] Google sign-in wallets (Phase 2b, replaces passkeys): Turnkey Google sign-in, one sub-org per user, session key signs requests, sign-up proves key ownership. Client ID and origin setup are in docs/sessions/T02_CONTEXT.md.
- [ ] Update the SoW for Google sign-in, one Withdraw button, and GitHub Actions deploys.
- [ ] Move into ROFL (Phase 3): Dockerfile (must run `npm run build`, which bundles the page), rofl.yaml, secrets, persistent volume at STATE_PATH, keys from rofl-appd (feed their raw bytes to `apiKeyFromRaw`), redo vault setup with enclave keys. Setup today reads the app's keys from the local folder; for ROFL it must instead take the admin public key the running app shows, and the app bootstraps the rest itself on start.
- [ ] Base Sepolia and swaps (Phase 4): code and page done and tested on local chains; needs Will's pool seeding (set LIQUIDITY_PROVIDER to his account ID) and a real end-to-end check.
- [ ] Proof page (Phase 5): attestation, key control (live from Turnkey: the vault's users, root quorum, and the two policies), solvency, signing history, and a header link to it.

## Later / optional

- [ ] Solana as a third asset (one vault address plus a policy).
- [ ] Rebalancing between vault addresses when one runs short.
- [ ] Hook the Under the hood panel to Turnkey activity IDs once the vault is real.
- [ ] A withdrawal whose transaction is dropped stays locked until a later withdrawal uses the same vault address; add a rebroadcast or timeout if it ever happens in practice.
- [ ] Under the hood history lives in memory and clears on restart; persist it if rehearsals need it.

## Done


- [x] T02 (Sept 23-24): trading page with stand-in login; fixed deposits never being credited on a fresh start; withdrawals stay locked when a broadcast errors; stand-in vault makes its own key phrase. Phase 1: Turnkey vault in Will's org (sub-organization with the app's admin key as sole root, vault wallet, signer limited to Sepolia and Base Sepolia up to 0.05 ETH, deny above 0.05 ETH); live checks passed; parent org can read the vault but cannot sign. Decisions for T03: Google sign-in, one Withdraw button, GitHub Actions deploys. 26 tests.

- [x] T01 (Sept 23): repo, ledger with tests, signed requests with sequence numbers, EVM deposit scanning with two-provider check, withdrawal flow, stand-in vault, server skeleton, SoW snapshot, workflow docs, CI.
