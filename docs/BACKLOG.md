# Backlog

Actionable work only, roughly in order. Facts that are not work live as comments in the code where the next person would be standing (see docs/WORKFLOW.md).

## Next up

- [ ] Deploy via GitHub Actions (replaces local Phase 0b tooling). The workflow:
  - builds the image, pushes it to ghcr.io, and builds the ROFL bundle with rofl-dev;
  - runs `oasis rofl create/update/deploy` with a deploy wallet kept as a repo secret.
  Claude creates the deploy wallet; Will sends it about 150 TEST from MetaMask. The repo is already public; after the first build, check the ghcr package is public and, if not, show Will the one switch. The first deploy doubles as the smoke test. Record the ROFL URL.
- [ ] One Withdraw button: remove Try to break it and the app's own per-withdrawal cap so Turnkey's policy is the only limit.
- [ ] Google sign-in wallets (Phase 2b, replaces passkeys): Turnkey Google sign-in, one sub-org per user, session key signs requests, sign-up proves key ownership. Client ID is in docs/sessions/T02_CONTEXT.md.
- [ ] Walk Will step by step through adding the ROFL URL to the SimpleBlueprints Google client's Authorized JavaScript origins (and a redirect URI if the flow needs one), then have him sign in with Google.
- [ ] First real-testnet run (Will, once he has test ETH), on the ROFL deployment:
  1. deposit Sepolia ETH;
  2. send to a second account;
  3. withdraw to MetaMask;
  4. try 0.06 ETH and find Turnkey's rejection in the dashboard.
- [ ] Billing check (Will, when convenient): Turnkey's usage page should show 2 signatures used, with the refused ones not counted. Will is holding off on the pay-as-you-go card until the 25 free monthly signatures run short.
- [ ] Move into ROFL (Phase 3): Dockerfile (must run `npm run build`, which bundles the page), rofl.yaml, secrets, persistent volume at STATE_PATH, keys from rofl-appd (feed their raw bytes to `apiKeyFromRaw`), redo vault setup with enclave keys. Setup today reads the app's keys from the local folder; for ROFL it must instead take the admin public key the running app shows, and the app bootstraps the rest itself on start.
- [ ] Base Sepolia and swaps (Phase 4): code and page done and tested on local chains; needs Will's pool seeding (set LIQUIDITY_PROVIDER to his account ID; added liquidity cannot be withdrawn) and a real end-to-end check.
- [ ] Proof page (Phase 5): attestation, key control (live from Turnkey: the vault's users, root quorum, and the two policies), solvency, signing history, and a header link to it.

## Later / optional

- [ ] Solana as a third asset (one vault address plus a policy).
- [ ] Rebalancing between vault addresses when one runs short.
- [ ] Hook the Under the hood panel to Turnkey activity IDs once the vault is real.
- [ ] A withdrawal whose transaction is dropped stays locked until a later withdrawal uses the same vault address; add a rebroadcast or timeout if it ever happens in practice.
- [ ] Under the hood history lives in memory and clears on restart; persist it if rehearsals need it.

## Done


- [x] T02 (Sept 23-24): trading page with stand-in login; fixed deposits never being credited on a fresh start; withdrawals stay locked when a broadcast errors; stand-in vault makes its own key phrase. Phase 1: Turnkey vault in Will's org (sub-organization with the app's admin key as sole root, vault wallet, signer limited to Sepolia and Base Sepolia up to 0.05 ETH, deny above 0.05 ETH); live checks passed; parent org can read the vault but cannot sign. Decisions for T03: Google sign-in, one Withdraw button, GitHub Actions deploys; SoW updated to match (rev 65). 26 tests.

- [x] T01 (Sept 23): repo, ledger with tests, signed requests with sequence numbers, EVM deposit scanning with two-provider check, withdrawal flow, stand-in vault, server skeleton, SoW snapshot, workflow docs, CI.
