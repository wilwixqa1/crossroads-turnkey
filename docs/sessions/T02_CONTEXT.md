# T02 context (Sept 23-24, 2026)

Session 2 is this whole chat. It built the trading page, did Phase 1 (the Turnkey vault), and ended with three design decisions that T03 starts from. Session numbers follow Will's chats: one chat is one session.

## Where the design lives
- Living SoW (Claude Doc): https://claude.ai/code/artifact/6e5f1007-0475-40d2-96cd-7c38fbe43def (rev 22)
- Snapshot in this repo: docs/SOW.md. One sentence was added this session. The SoW does not yet reflect the Sept 24 decisions below; updating it is on the backlog.

## What session 2 did

### Trading page, with a stand-in login and a stand-in vault
- Built the trading page:
  - balances, deposit address and pool rate;
  - Deposit, Swap, Send, Withdraw and Add liquidity tabs, plus Try to break it on the Withdraw tab;
  - an In flight list where arriving deposits count their confirmations;
  - an activity feed tagged Instant (with settlement time) or On-chain (with explorer link);
  - the Under the hood panel;
  - light and dark themes.
- The page signs every request through one swappable signer (web/signer.ts).
- Fixed three problems in T01's backend:
  1. On a fresh start the deposit scanner never recorded where to begin, so no deposit would ever have been credited.
  2. A withdrawal whose broadcast errored was unlocked even though its transaction might still land. Funds now stay locked until it confirms or another transaction takes its slot.
  3. The stand-in vault defaulted to the public test phrase. It now makes its own random phrase beside the saved state.
- Also: only the configured liquidity provider can add to the pool; withdrawals are numbered #1, #2 on screen; fee amounts in Under the hood round to six decimals; CI bundles the page.

### Phase 1: the Turnkey vault
- Will's Turnkey organization: "Will's Turnkey_Test" (fa26e2cd-7656-4db6-b26f-3012c3b578e8). His parent API key was used only for setup and the checks, passed in as settings for those runs. It is in no file and not in git.
- The vault is a sub-organization whose only root user is the app's admin key. Inside it:
  - one wallet; each user's deposit address is one more account in it;
  - a signer user with no powers except two policies:
    1. allow signing Ethereum transactions from the vault wallet on Sepolia or Base Sepolia, up to 0.05 ETH;
    2. deny anything above 0.05 ETH.
- `npm run turnkey:setup` creates the sub-organization with Will's key, then acts as the app's admin to create the wallet, signer and policies. It is safe to re-run.
- `npm run turnkey:check` runs the Phase 1 checks live. All passed:
  1. the signer signs a small Sepolia withdrawal;
  2. Turnkey refuses 0.06 ETH;
  3. Turnkey refuses another chain;
  4. the parent org can read the vault but not sign with it ("organization mismatch").
- Turnkey accepted app keys built from 32 raw bytes, the form ROFL hands the app.
- The app runs on the vault with `VAULT_MODE=turnkey`. On start it refuses a saved ledger whose deposit addresses the vault does not hold.
- Refusals read plainly on screen ("Policy refused: 0.06 ETH is above the 0.05 ETH per-withdrawal cap"). Turnkey itself only says "insufficient permissions"; the app names the limit.
- Full page flow on local chains posing as Sepolia, with the real Turnkey vault:
  - sign-up, with Turnkey creating the deposit address;
  - a deposit;
  - a 0.01 ETH withdrawal that Turnkey signed and the chain confirmed;
  - Try to break it, refused by Turnkey in about 120 ms.
- Will looked at the vault in his dashboard: its users, policies and wallet, and the rejected signature with the cap policy marked Denied. The dashboard offers his account no way to sign with the vault.
- Signatures used on Will's account: 2 billable; 4 refused.
- Tests: 26, up from 9. CI green on main.

## The vault created this session is throwaway
Its app keys lived in this session's workspace, which is wiped at session end. It stays visible in Will's dashboard ("Crossroads vault 2026-09-23 23:25", sub-organization b27be120-f67a-4201-a073-99d561e1719e), but nothing can sign for it again. Every new workspace runs setup once and gets its own vault. The one that matters is created in ROFL with enclave keys.

## Decisions made Sept 24 (not yet built; T03 starts here)
1. Sign-in is Google, not passkeys. Each user gets a Turnkey wallet through Turnkey's Google sign-in, and a short-lived session signs requests, so every action is one click. MetaMask stays only the outside wallet for deposits and withdrawals.
   - Google Client ID: 295336183237-90umhku3e7jck9tktd5dikc6ru7bc2he.apps.googleusercontent.com. It is not secret.
   - It is SimpleBlueprints' existing Google client; Will chose to reuse it and does not mind Google's window showing the SimpleBlueprints name.
   - Will must add each Crossroads address (the ROFL URL after the first deploy) to its Authorized JavaScript origins.
   - Google sign-in can only be tested by Will in a real browser, so it is first exercised on the ROFL URL.
2. One Withdraw button. Remove Try to break it and the app's own per-withdrawal cap, so Turnkey's policy is the only limit. Typing 0.06 ETH into Withdraw gets Turnkey's refusal, which Will then finds in his dashboard (vault, then Activities).
3. Deploy through GitHub Actions; Will installs nothing (no Docker, Oasis CLI, Docker Hub or Node.js). A workflow:
   - builds the image and pushes it to ghcr.io;
   - builds the ROFL bundle with the rofl-dev image;
   - runs `oasis rofl create/update/deploy` with a deploy wallet whose key is a GitHub repo secret.
   Will funds that wallet with TEST from MetaMask. The deploy wallet becomes the ROFL app admin. The laptop backup becomes a recorded rehearsal.

## How to start T03
Paste a GitHub token, say "T03, continue from docs/sessions/T02_CONTEXT.md", and Claude clones the repo and reads docs/SOW.md, docs/BACKLOG.md, and this file. For Turnkey work, also paste Will's org ID and parent API key; they are not stored anywhere.

## What is next (suggested T03 order)
1. The deploy workflow, and a first deploy of the current app. This is also the ROFL smoke test.
2. One Withdraw button.
3. Google sign-in.
4. Will adds the ROFL URL to the Google client and tests sign-in.
5. Update the SoW for all three decisions.

## Waiting on Will
- Sepolia and Base Sepolia test ETH (about 0.3 and 0.1).
- In T03: send TEST tokens from MetaMask to the deploy wallet Claude creates.
- A card on Turnkey for pay-as-you-go, if not yet added.
- Join the Turnkey Verifiable Cloud waitlist.

## Code comments
Written during the session (in new code):
- web/main.ts, `breakIt`: the only place bypassAppCap may be sent. This goes away with decision 2.
- src/signer/turnkey.ts, signTransaction: the ledger keeps addresses lowercase, but Turnkey matches the checksummed form.
- src/signer/turnkey.ts, signTransaction: Turnkey answers every policy refusal the same way, so the app names the broken limit itself.

Added in two insert-only close-out commits (7 lines added, 0 removed):
- src/app.ts, withdrawal send step: the funds check runs before the vault is asked, so an over-cap request only reaches the vault's policy when one vault address holds more than the amount plus fee.
- public/index.html, script tag: app.js is bundled from web/ and is not in git; rebuild after editing web/, and the ROFL image must run the same build.
- src/signer/turnkey.ts, loadOrCreateAppKeys: losing the app keys file means the vault can never sign again; workspace vaults are throwaway, so send them test amounts only.
- src/signer/turnkey.ts, policy step of setup: policies are matched by name only; to change the cap or chains, set up a fresh vault.

## Gotchas for the next session (same facts, for a reader who starts here)
- A withdrawal above the cap reaches Turnkey only if the user has more than that amount available on the chain and one vault address holds it on-chain. The app locks funds first, so with less it stops for lack of funds and Turnkey never sees it. Deposit 0.07 before demoing the refusal.
- A vault's app keys live beside STATE_PATH. Lose them and the vault is permanently unusable; that is encumbrance working, not a bug.
- Changing WITHDRAWAL_CAP or the chains does not update an existing vault's policies. Make a fresh vault.
- Turnkey mode with an old stand-in ledger refuses to start. Use a fresh STATE_PATH folder.
- The page is bundled into public/app.js, which is not committed. `npm run dev` bundles once; `npm run dev:web` rebuilds on change.
- The stand-in vault's phrase lives in `local-vault-mnemonic.txt` beside STATE_PATH.
- Set LIQUIDITY_PROVIDER to Will's account ID wherever the demo runs, or anyone can add to the pool.

## Lessons
- Local chains beat testnets for end-to-end checks. Start Foundry's anvil with `--chain-id 11155111` and `--chain-id 84532`, and point SEPOLIA_RPC_URLS / BASE_SEPOLIA_RPC_URLS at them; the same node listed twice satisfies the two-provider rule. Playwright with headless Chromium is available in the container.
- Start long-running processes from a script file with setsid/nohup. A `pkill -f` whose pattern appears in the same command line kills the shell running it.
- App-level tests with stand-in network providers surfaced the deposit-scanner bug that the T01 live run missed.
- Turnkey's policy language accepted the conditions as written: `activity.type`, `wallet.id`, numeric `eth.tx.chain_id`, and `eth.tx.value` in wei.
- Signing a test transaction with an absurd transaction number checks policies live without anything usable on-chain.
- Say "Crossroads", "Turnkey", "your MetaMask" and "the chains", never "the app", when talking to Will. Mixing those up caused real confusion this session.
