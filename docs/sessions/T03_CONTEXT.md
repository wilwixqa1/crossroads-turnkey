# T03 context (Sept 23, 2026)

## Where the design lives
- Living SoW (Claude Doc): https://claude.ai/code/artifact/6e5f1007-0475-40d2-96cd-7c38fbe43def (unchanged this session, rev 22)
- Snapshot in this repo: docs/SOW.md

## What T03 did (Phase 1: the Turnkey vault)
- Will's Turnkey organization: "Will's Turnkey_Test" (fa26e2cd-7656-4db6-b26f-3012c3b578e8). His parent API key was used only for setup and the checks, passed in as settings for those runs; it is in no file and not in git.
- Built the real vault. It is a sub-organization in Will's org whose only root user is the app's admin key. Inside it: one wallet (each user's deposit address is one more account in it) and a signer user with no powers except two policies:
  1. allow signing Ethereum transactions from the vault wallet on Sepolia or Base Sepolia, up to 0.05 ETH;
  2. deny anything above 0.05 ETH.
- A one-time setup (`npm run turnkey:setup`) creates the sub-organization with Will's key, then acts as the app's admin to create the wallet, signer and policies. It is safe to re-run.
- A check (`npm run turnkey:check`) runs the Phase 1 checks live. All passed:
  1. the signer signs a small Sepolia withdrawal;
  2. Turnkey refuses 0.06 ETH;
  3. Turnkey refuses another chain;
  4. the parent org can read the vault but cannot sign with it ("organization mismatch").
- Turnkey accepted the app's keys built from 32 raw bytes, which is the form ROFL will hand the app in Phase 3.
- The app runs on the Turnkey vault with `VAULT_MODE=turnkey`. On start it refuses a saved ledger whose deposit addresses the vault does not hold.
- Full page flow on local chains posing as Sepolia, with the real Turnkey vault:
  - sign-up (Turnkey created the deposit address);
  - deposit;
  - a 0.01 ETH withdrawal that Turnkey signed and the chain confirmed;
  - Try to break it, which Turnkey refused in about 120 ms, with the funds unlocked.
- Refusals read plainly on screen ("Policy refused: 0.06 ETH is above the 0.05 ETH per-withdrawal cap"). Turnkey itself only says "insufficient permissions"; the app names the limit the request broke.
- The banner now says the login is still a stand-in when the vault is Turnkey.
- Tests: 26, up from 20; they stand in for Turnkey and need no network. CI green on main.
- Signatures used on Will's account: 2 billable (one check, one withdrawal); 4 refused.

## The vault created this session is throwaway
Its app keys lived in this session's workspace, which is wiped at session end. It stays visible in Will's dashboard ("Crossroads vault 2026-09-23 …", sub-organization b27be120-f67a-4201-a073-99d561e1719e) but nothing can sign for it again. Every new workspace or laptop runs setup once and gets its own vault. The one that matters is created in Phase 3 with enclave keys.

## How to start T04
Paste a GitHub token, say "T04, continue from docs/sessions/T03_CONTEXT.md", and Claude clones the repo and reads docs/SOW.md, docs/BACKLOG.md, and this file. For Turnkey work, also paste Will's org ID and parent API key again; they are not stored anywhere.

## What is next (see docs/BACKLOG.md)
1. Will's hands-on Phase 1 look in the Turnkey dashboard, plus the billing check.
2. ROFL smoke test (Phase 0b), once Will has Docker, the Oasis CLI and Oasis testnet tokens.
3. Passkey wallets (Phase 2b): these use Will's Turnkey org, so they can start now.

## Waiting on Will (Phase 0)
Sepolia and Base Sepolia test ETH, Oasis testnet tokens, Docker Hub account, Docker + Oasis CLI, Node.js, network provider account, passkey check on the demo laptop, and the TVC waitlist. The Turnkey account is done; add a card for pay-as-you-go if not yet done.

## Code comments
Written during the session (in new code):
- src/signer/turnkey.ts, signTransaction: the ledger keeps addresses lowercase, but Turnkey matches the checksummed form.
- src/signer/turnkey.ts, signTransaction: Turnkey answers every policy refusal the same way, so the app names the broken limit itself.

Added at close-out (insert-only commit, 4 lines added, 0 removed):
- src/signer/turnkey.ts, loadOrCreateAppKeys: losing the app keys file means the vault can never sign again; workspace vaults are throwaway, so send them test amounts only.
- src/signer/turnkey.ts, policy step of setup: policies are matched by name only; to change the cap or chains, set up a fresh vault instead of editing the strings.

## Gotchas for the next session (same facts, for a reader who starts here)
- A vault's app keys live beside STATE_PATH. Lose them and the vault is permanently unusable. That is encumbrance working, not a bug.
- Changing WITHDRAWAL_CAP or the chains does not update an existing vault's policies. Make a fresh vault.
- Turnkey mode with an old stand-in ledger refuses to start. Use a fresh STATE_PATH folder.
- The parent key is needed only for setup and the check. The app never reads it.

## Lessons
- Turnkey's policy language accepted the conditions as written: `activity.type`, `wallet.id`, numeric `eth.tx.chain_id` comparisons, and `eth.tx.value` compared against wei.
- Signing a test transaction with an absurd transaction number is a clean way to check policies live: the allowed signature can never be used on-chain, and nothing is broadcast.

## Decisions made after close-out (Sept 24, same chat). T04 starts here
1. Sign-in is Google, not passkeys. Each user gets a Turnkey wallet through Turnkey's Google sign-in, and a short-lived session signs requests, so every action is one click. MetaMask stays only the outside wallet for deposits and withdrawals.
   - Google Client ID: 295336183237-90umhku3e7jck9tktd5dikc6ru7bc2he.apps.googleusercontent.com. It is not secret.
   - It is SimpleBlueprints' existing Google client, which Will chose to reuse. Google's sign-in window will therefore show the SimpleBlueprints name.
   - Will must add each Crossroads address (the ROFL URL after the first deploy) to its Authorized JavaScript origins.
   - Google sign-in can only be tested by Will in a real browser, so it is first exercised on the ROFL URL.
2. One Withdraw button. Remove Try to break it, and remove the app's own per-withdrawal cap, so Turnkey's policy is the only limit. Typing 0.06 ETH into Withdraw gets Turnkey's refusal, which Will then finds in his dashboard (vault, then Activities).
3. Deploy through GitHub Actions; Will installs nothing (no Docker, Oasis CLI, Docker Hub or Node.js). A workflow:
   - builds the image and pushes it to ghcr.io;
   - builds the ROFL bundle with the rofl-dev image;
   - runs `oasis rofl create/update/deploy` with a deploy wallet whose key is a GitHub repo secret.
   Will funds that wallet with TEST from MetaMask. The deploy wallet becomes the ROFL app admin. The laptop backup becomes a recorded rehearsal.
4. Suggested T04 order:
   1. the deploy workflow, and a first deploy of the current app;
   2. one Withdraw button;
   3. Google sign-in;
   4. Will adds the ROFL URL to the Google client and tests sign-in;
   5. update the SoW for all of the above.

