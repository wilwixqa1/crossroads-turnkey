# T02 context (Sept 23, 2026)

## Where the design lives
- Living SoW (Claude Doc): https://claude.ai/code/artifact/6e5f1007-0475-40d2-96cd-7c38fbe43def (doc rev 22 at close)
- Snapshot in this repo: docs/SOW.md (one sentence added this session, see below)

## What T02 did
- Built the trading page with a stand-in login: balances, deposit address, pool rate, Deposit/Swap/Send/Withdraw/Add liquidity tabs, Try to break it on the Withdraw tab, an In flight list where arriving deposits count their confirmations, an activity feed tagged Instant (with settlement time) or On-chain (with explorer link), the Under the hood panel, and light and dark themes.
- The page signs every request through one swappable signer. Phase 2b replaces the stand-in key with a Turnkey passkey wallet without touching the rest of the page.
- Ran the whole flow in a real browser against two local chains posing as Sepolia and Base Sepolia: sign-up, deposits on both chains, liquidity, swap, send, a withdrawal that signed, confirmed and refunded its unused fee, and Try to break it refused by the stand-in policy with funds unlocked. Balances reconciled exactly.
- Fixed three problems in T01's backend:
  1. On a fresh start the deposit scanner never recorded where to begin, so no deposit would ever have been credited. A test proves the old version failed.
  2. If the network errored while broadcasting a withdrawal, the app unlocked the funds even though the transaction might still land. Funds now stay locked until it confirms or another transaction takes its slot.
  3. The stand-in vault defaulted to the well-known public test phrase, whose Sepolia addresses get swept by bots. It now makes its own random phrase on first start and keeps it beside the saved state.
- Also: only the configured liquidity provider can add to the pool; withdrawals are numbered #1, #2 on screen; fee amounts in Under the hood round to six decimals.
- Tests: 20, up from 9. CI now also bundles the page. CI green on main.
- SoW: "Before each demo" now says the account pressing Try to break it needs at least 0.07 Sepolia ETH deposited.

## How to start T03
Paste a GitHub token, say "T03, continue from docs/sessions/T02_CONTEXT.md", and Claude clones the repo and reads docs/SOW.md, docs/BACKLOG.md, and this file.

## What is next (see docs/BACKLOG.md)
1. Turnkey vault (Phase 1) as soon as Will's Turnkey org and parent API key exist.
2. Will's real-testnet check of the page with the stand-in vault once he has Sepolia ETH.
3. ROFL smoke test (Phase 0b).

## Waiting on Will (Phase 0)
Unchanged from T01: Turnkey org + parent API key (blocks Phase 1), Sepolia and Base Sepolia test ETH, Oasis testnet tokens, Docker Hub account, Docker + Oasis CLI, network provider keys.

## Code comments
Written during the session (in new code):
- web/main.ts, `breakIt`: this is the only place bypassAppCap may be sent.

Added at close-out (insert-only commit, 3 lines added, 0 removed):
- src/app.ts, withdrawal send step: the funds check runs before the vault is asked, so Try to break it only reaches the vault's policy when one vault address holds more than the cap plus fee.
- public/index.html, script tag: app.js is bundled from web/ and is not in git; rebuild after editing web/, and the ROFL image must run the same build.

## Gotchas for the next session (same facts, for a reader who starts here)
- Try to break it needs more than 0.06 ETH available on that chain in the user's balance and in one vault address on-chain. Otherwise the app stops it for lack of funds before the vault is asked.
- The page is bundled into public/app.js, which is not committed. `npm run dev` bundles once; `npm run dev:web` rebuilds on change.
- The stand-in vault's key phrase lives in `local-vault-mnemonic.txt` beside STATE_PATH. A fresh state folder gets a fresh phrase; deleting the phrase while keeping the state fails loudly on start.
- Set LIQUIDITY_PROVIDER to Will's account ID wherever the demo runs, or anyone can add to the pool.
- `.env` is optional now (`--env-file-if-exists`).

## Lessons
- Local chains beat testnets for end-to-end checks: Foundry's anvil started with `--chain-id 11155111` and `--chain-id 84532`, and SEPOLIA_RPC_URLS / BASE_SEPOLIA_RPC_URLS pointed at them (the same node listed twice satisfies the two-provider rule). Deposits, confirmations, withdrawals and refusals all run for real with no faucet. Playwright with headless Chromium is available in the container for screenshots.
- Start long-running processes from a script file with setsid/nohup. A `pkill -f` whose pattern appears in the same command line kills the shell running it.
- Writing app-level tests with stand-in network providers is what surfaced the deposit-scanner bug; the T01 live run never had a deposit to catch it.
