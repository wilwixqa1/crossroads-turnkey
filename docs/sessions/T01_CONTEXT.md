# T01 context (Sept 23, 2026)

## Where the design lives
- Living SoW (Claude Doc): https://claude.ai/code/artifact/6e5f1007-0475-40d2-96cd-7c38fbe43def
- Snapshot in this repo: docs/SOW.md

## What T01 did
- Reviewed the Liquefaction and Crossroads papers and both public repos; wrote and revised the SoW.
- Design decisions made this session: ledger lives in the ROFL app (no smart contracts); Turnkey plays two roles (per-user passkey wallets and an app-owned encumbered vault); per-user deposit addresses instead of deposit tagging; Solana deferred, Base Sepolia is the second chain; withdrawals run in parallel across vault addresses; every user request carries a sequence number.
- Built the backend skeleton: ledger with 9 tests, signed requests, EVM deposit scanning with two-provider agreement, withdrawal flow, local stand-in vault, Fastify server, placeholder page. Ran it live against Sepolia and Base Sepolia public endpoints.
- Created this repo and pushed. Will made it public at the end of T01 so GitHub Actions runs free; the CI gate is green on main.

## How to start T02
Paste a GitHub token, say "T02, continue from docs/sessions/T01_CONTEXT.md", and Claude clones the repo and reads docs/SOW.md, docs/BACKLOG.md, and this file.

## What is next (see docs/BACKLOG.md)
1. Trading page with stand-in login.
2. Turnkey vault as soon as Will's Turnkey org exists.

## Waiting on Will (Phase 0)
Turnkey org + parent API key (blocks Phase 1), Sepolia and Base Sepolia test ETH, Oasis testnet tokens, Docker Hub account, Docker + Oasis CLI, network provider keys.

## Code comments added at close-out (insert-only, 10 lines added, 0 removed)
- src/signer/index.ts: mnemonic must match saved state; use a fresh STATE_PATH to change it
- src/app.ts: deposit scan starts at the tip on first run
- src/app.ts: bypassAppCap is for Try to break it only
- src/server.ts: every bigint leaves the API as a decimal string
- src/ledger/ledger.ts: a failed request still burns its sequence number

## Gotchas for the next session (same facts, for a reader who starts here)
- `LocalVault` re-derives addresses from the mnemonic in order at startup and fails loudly if the mnemonic does not match saved state. Change the mnemonic only with a fresh STATE_PATH.
- Deposit scanning starts at the current tip on first run; it does not replay history. Fund an address only after the app is running, or lower the cursor by hand.
- The app's per-withdrawal cap is a first gate; the request param `bypassAppCap=true` exists only so "Try to break it" can reach Turnkey's policy. Never expose it in the normal UI path.
- Fastify replies serialize bigint as strings; the page must treat every amount as a decimal string.

## Lessons
- Reading the Crossroads repo before designing saved a full rewrite: its lock/canSign/confirm sequence maps directly onto the ledger.
- Keep a snapshot of the SoW in the repo; the Claude Doc is easier to edit but a future session with no chat history needs the repo copy.
