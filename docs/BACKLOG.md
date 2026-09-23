# Backlog

Actionable work only, roughly in order. Facts that are not work live as comments in the code where the next person would be standing (see docs/WORKFLOW.md).

## Next up

- [ ] Trading page (Phase 2 UI): sign-up, balances, Deposit/Swap/Send/Withdraw tabs, Under the hood panel, activity feed. Stand-in login until 2b.
- [ ] Turnkey vault (Phase 1): vault sub-org, vault wallet, signer user, policies; swap `LocalVault` for `TurnkeyVault`; setup script for Will. Needs Will's Turnkey org ID and parent API key.
- [ ] Phase 1 checks: over-cap withdrawal refused by Turnkey; Will's parent org cannot sign; confirm a refused signature is not billed; confirm Turnkey accepts an API key derived from raw key material.
- [ ] ROFL smoke test (Phase 0b): trivial container on ROFL testnet with a public URL, driven by Will with guidance.
- [ ] Passkey wallets (Phase 2b): sign-up/login, one sub-org per user, requests signed by the user's Turnkey wallet.
- [ ] Move into ROFL (Phase 3): Dockerfile, rofl.yaml, secrets, persistent volume at STATE_PATH, keys from rofl-appd, redo vault setup with enclave keys.
- [ ] Base Sepolia and swaps (Phase 4): already wired in code; needs pool seeding, add-liquidity tab, end-to-end check.
- [ ] Proof page (Phase 5): attestation, key control (live from Turnkey), solvency, signing history; Try to break it button.

## Later / optional

- [ ] Solana as a third asset (one vault address plus a policy).
- [ ] Rebalancing between vault addresses when one runs short.
- [ ] Hook the Under the hood panel to Turnkey activity IDs once the vault is real.

## Done

- [x] T01 (Sept 23): repo, ledger with tests, signed requests with sequence numbers, EVM deposit scanning with two-provider check, withdrawal flow, stand-in vault, server skeleton, SoW snapshot, workflow docs, CI.
