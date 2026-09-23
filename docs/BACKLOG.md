# Backlog

Actionable work only, roughly in order. Facts that are not work live as comments in the code where the next person would be standing (see docs/WORKFLOW.md).

## Next up

- [ ] Phase 2 check on real testnets (Will, once he has test ETH): run on a laptop with the stand-in vault; deposit Sepolia ETH, send to a second account, withdraw to MetaMask.
- [ ] Turnkey vault (Phase 1): vault sub-org, vault wallet, signer user, policies; swap `LocalVault` for `TurnkeyVault`; setup script for Will. Needs Will's Turnkey org ID and parent API key.
- [ ] Phase 1 checks: over-cap withdrawal refused by Turnkey; Will's parent org cannot sign; confirm a refused signature is not billed; confirm Turnkey accepts an API key derived from raw key material.
- [ ] ROFL smoke test (Phase 0b): trivial container on ROFL testnet with a public URL, driven by Will with guidance.
- [ ] Passkey wallets (Phase 2b): sign-up/login, one sub-org per user, requests signed by the user's Turnkey wallet. The page's signer is already swappable (web/signer.ts); sign-up should also prove key ownership, since the stand-in sign-up call is unauthenticated.
- [ ] Move into ROFL (Phase 3): Dockerfile (must run `npm run build`, which bundles the page), rofl.yaml, secrets, persistent volume at STATE_PATH, keys from rofl-appd, redo vault setup with enclave keys.
- [ ] Base Sepolia and swaps (Phase 4): code and page done and tested on local chains; needs Will's pool seeding (set LIQUIDITY_PROVIDER to his account ID) and a real end-to-end check.
- [ ] Proof page (Phase 5): attestation, key control (live from Turnkey), solvency, signing history, and a header link to it. Try to break it already lives on the Withdraw tab.

## Later / optional

- [ ] Solana as a third asset (one vault address plus a policy).
- [ ] Rebalancing between vault addresses when one runs short.
- [ ] Hook the Under the hood panel to Turnkey activity IDs once the vault is real.
- [ ] A withdrawal whose transaction is dropped stays locked until a later withdrawal uses the same vault address; add a rebroadcast or timeout if it ever happens in practice.
- [ ] Under the hood history lives in memory and clears on restart; persist it if rehearsals need it.

## Done

- [x] T02 (Sept 23): trading page with stand-in login (balances, Deposit/Swap/Send/Withdraw/Add liquidity, Try to break it, In flight with confirmation counts, activity feed, Under the hood, light and dark); fixed deposits never being credited on a fresh start; withdrawals stay locked when a broadcast errors; stand-in vault makes its own key phrase; 20 tests; full flow run on local chains posing as Sepolia and Base Sepolia.

- [x] T01 (Sept 23): repo, ledger with tests, signed requests with sequence numbers, EVM deposit scanning with two-provider check, withdrawal flow, stand-in vault, server skeleton, SoW snapshot, workflow docs, CI.
