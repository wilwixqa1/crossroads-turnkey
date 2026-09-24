# T02 context (Sept 23-24, 2026)

Session 2 is this whole chat. It built the trading page, did Phase 1 (the Turnkey vault), and then spent a long stretch settling what the product is and how it gets deployed. Session 3 starts from the decisions at the bottom of "What was decided".

## How session 3 starts
Will pastes this file and says "let's begin session 3". Claude then:
1. clones github.com/wilwixqa1/crossroads-turnkey (public, so no token is needed to read it);
2. reads docs/SOW.md and docs/BACKLOG.md;
3. asks Will, only when needed, for a GitHub token (to push) and his Turnkey org ID and API key (for setup). Neither is stored anywhere.

## Where the design lives
- Living SoW (Claude Doc): https://claude.ai/code/artifact/6e5f1007-0475-40d2-96cd-7c38fbe43def, rev 65 at close.
- Snapshot in this repo: docs/SOW.md, matching rev 65.
- The SoW was updated this session for everything decided below:
  - Google sign-in instead of passkeys;
  - one Withdraw button, with Turnkey's refusal shown on the normal form;
  - GitHub Actions deploys and a recorded rehearsal as the backup;
  - the deploy wallet as the ROFL app admin;
  - Phase 1's answer on parent-org access;
  - a refreshed Phase 0 checklist.

## Working with Will (read first)
- One chat is one session ("CR session N" = TN). He starts by pasting the latest context file.
- He does not read code. Every reply is plain English: what changed and what it means for him. No file names or tooling internals in replies.
- Use four names and never "the app" loosely:
  - Crossroads: the website plus ledger, running in ROFL.
  - Turnkey: holds each user's wallet and, separately, the vault.
  - Your MetaMask: his outside wallet.
  - The chains: Sepolia and Base Sepolia.
  Mixing these up caused a long, frustrated detour this session.
- He does not want to install anything locally. Everything runs in Claude's workspace or on GitHub.
- He dislikes passkeys.
- He wants the demo to feel like a real app, not a test harness.

## What Crossroads is (agreed Sept 24, after confusion)
An exchange like Coinbase, not like Uniswap: users move money in once, trade inside instantly with no blockchain transaction, and move money out when done. The difference from Coinbase is that the vault holding everyone's money is controlled by verified code plus Turnkey's rules, not a company. The user's day:
1. **Sign in with Google.** Turnkey creates or opens the user's own wallet, whose address is their account ID. A short-lived session then signs every request, so each action is one click.
2. **Deposit.** Send test ETH from MetaMask to the deposit address Crossroads shows, as an on-chain transfer signed in MetaMask. The balance appears once confirmed.
3. **Trade and send.** One click each; these are ledger updates, not blockchain transactions.
4. **Withdraw.** Enter an amount and any address, usually the user's own MetaMask. Crossroads asks the Turnkey vault to sign, the transaction goes on-chain, and the ETH arrives in MetaMask.

The on-camera refusal:
1. The user types 0.06 ETH into the normal Withdraw form.
2. Crossroads locks the funds and asks the vault.
3. Turnkey refuses, and Crossroads unlocks.
4. Will opens the Turnkey dashboard (Sub-Orgs, then the vault, then Activities) and shows the rejected "Sign transaction", where Policy evaluations mark the 0.05 ETH policy Denied.

The user's own session-signed request also shows under their personal wallet.

## Where things run and where keys live
- **Hosting.** Crossroads serves its own page, so there is no separate front-end host. In ROFL, the Oasis-run testnet provider rents the machine by the hour and gives a public address, and TLS ends inside the enclave, so the operator cannot read or change traffic.
  - Railway and Vercel were rejected. Both are ordinary hosting Will controls, which undercuts the verified-app claim. Vercel is also serverless: no long-running process, no persistent file.
- **Changing Crossroads.** Will controls which version runs by deploying new versions, each recorded on Oasis. He cannot edit the running app or its balances.
- **Vault wallet keys:** only inside Turnkey's hardware. Nobody can see them.
- **The app's two Turnkey access keys (admin and signer):** today in a file beside STATE_PATH. In ROFL they are generated inside the enclave. The dashboard shows only their public halves.
  - Bryce talking point: app-admin is a root user, and root bypasses policies, so it could export wallet keys. The answer is that only the verified app holds app-admin and its code never calls export.
- **Will's parent Turnkey key:** used only for setup and the check. Never inside Crossroads.
- **Google Client ID:** public; lives in the page.
- **Deploy wallet key:** a GitHub repo secret. See decision 3.

## What session 2 did

### Trading page, with a stand-in login and a stand-in vault
- Built the trading page:
  - balances, deposit address and pool rate;
  - Deposit, Swap, Send, Withdraw and Add liquidity tabs, plus Try to break it (to be removed, see decision 2);
  - In flight, with confirmation counts;
  - an activity feed tagged Instant or On-chain;
  - Under the hood;
  - light and dark themes.
- The page signs every request through one swappable signer (web/signer.ts).
- Fixed three problems in T01's backend:
  1. On a fresh start the deposit scanner never recorded where to begin, so no deposit would ever have been credited.
  2. A withdrawal whose broadcast errored was unlocked though it might still land. Funds now stay locked until it confirms or another transaction takes its slot.
  3. The stand-in vault used the public test phrase. It now makes its own.
- Also: an LP-only liquidity gate, withdrawals numbered #1, #2, fees rounded in Under the hood, and CI bundles the page.

### Phase 1: the Turnkey vault
- Will's org: "Will's Turnkey_Test" (fa26e2cd-7656-4db6-b26f-3012c3b578e8).
- The vault is a sub-organization whose only root user is the app's admin key. Inside it:
  - one wallet; each user's deposit address is one more account;
  - a signer user limited to two policies:
    1. allow Ethereum transactions from the vault wallet on Sepolia or Base Sepolia, up to 0.05 ETH;
    2. deny above 0.05 ETH.
- `npm run turnkey:setup` creates it; `npm run turnkey:check` runs the live checks. All passed:
  1. the signer signs a small withdrawal;
  2. Turnkey refuses 0.06 ETH;
  3. Turnkey refuses another chain;
  4. the parent can read the vault but not sign with it.
- Turnkey accepted app keys built from 32 raw bytes, the form ROFL provides.
- The app runs on the vault with `VAULT_MODE=turnkey`. Refusals read plainly on screen.
- Full flow on local chains with Turnkey signing a real withdrawal and refusing an over-cap one.
- Will inspected the vault in his dashboard (users, policies, wallet, the rejected signature). His account has no way to sign with it.
- Signatures used: 2 billable, 4 refused.
- Tests: 26. CI green on main.

### The vault created this session is throwaway
Its app keys lived in this workspace, which is wiped at session end. It stays visible in Will's dashboard ("Crossroads vault 2026-09-23 23:25", b27be120-f67a-4201-a073-99d561e1719e), but nothing can sign for it again. Do not send it funds.

## What was decided (Sept 24; none of this is built yet)
1. **Google sign-in replaces passkeys.** Each user gets a Turnkey wallet through Turnkey's Google sign-in, and a short-lived session signs requests. MetaMask stays only the outside wallet.
   - Client ID: 295336183237-90umhku3e7jck9tktd5dikc6ru7bc2he.apps.googleusercontent.com. It is not secret.
   - It is SimpleBlueprints' existing Google client. Will does not mind Google's window saying SimpleBlueprints, and Crossroads sign-ins do not touch SimpleBlueprints' analytics.
   - Will must add each Crossroads address (the ROFL URL) to its Authorized JavaScript origins, and wants a step-by-step walkthrough.
   - Google sign-in can only be tested by Will in a real browser, so the first test is on the ROFL URL.
2. **One Withdraw button.** Remove Try to break it and the app's own per-withdrawal cap, so Turnkey's policy is the only limit.
3. **Deploy through GitHub Actions.** Will installs nothing: no Docker, Oasis CLI, Docker Hub or Node.js. A workflow:
   - builds the image and pushes it to ghcr.io;
   - builds the ROFL bundle with rofl-dev;
   - runs `oasis rofl create/update/deploy` with a deploy wallet.
   About the deploy wallet:
   - It is an ordinary Oasis testnet wallet, not in Turnkey and not encumbered.
   - It pays the 100-TEST registration deposit, the rental and fees, and becomes the ROFL app admin.
   - Its key is a repo secret. Will funds it with about 150 TEST from MetaMask.
   - Its admin power is the upgrade-rights caveat. The production fix is to move admin to a multisig or a contract with a delay.
   Other points:
   - The repo is already public. The ghcr package may still need its own public switch after the first build.
   - The laptop backup is now a recorded rehearsal.

## What is next (suggested T03 order)
1. The deploy workflow, and a first deploy of the current app. This is the smoke test.
2. One Withdraw button.
3. Google sign-in.
4. Walk Will through adding the ROFL URL to the Google client, then he signs in.
5. Phase 3 keys from rofl-appd.
6. The first real-testnet run once Will has test ETH.

## Waiting on Will
- Sepolia and Base Sepolia test ETH (about 0.3 and 0.1). He is working on it.
- In T03: about 150 TEST from MetaMask to the deploy wallet Claude creates.
- The pay-as-you-go card on Turnkey: deferred until the free 25 monthly signatures run short.
- The billing check on Turnkey's usage page.
- Done this session: Turnkey account and API key, Oasis testnet tokens, the TVC waitlist, and the Google Client ID.

## Code comments
Written during the session (in new code):
- web/main.ts, `breakIt`: the only place bypassAppCap may be sent. This goes away with decision 2.
- src/signer/turnkey.ts, signTransaction: the ledger keeps addresses lowercase, but Turnkey matches the checksummed form.
- src/signer/turnkey.ts, signTransaction: Turnkey answers every policy refusal the same way, so the app names the broken limit itself.

Added in two insert-only close-out commits (7 lines added, 0 removed):
- src/app.ts, withdrawal send step: the funds check runs before the vault is asked, so an over-cap request only reaches the vault's policy when one vault address holds more than the amount plus fee.
- public/index.html, script tag: app.js is bundled from web/ and is not in git; rebuild after editing web/, and the ROFL image must run the same build.
- src/signer/turnkey.ts, loadOrCreateAppKeys: losing the app keys file means the vault can never sign again; workspace vaults are throwaway.
- src/signer/turnkey.ts, policy step of setup: policies are matched by name only; to change the cap or chains, set up a fresh vault.

Final close-out pass (Sept 24): no code changed since the second comments commit, so none needed.

## Gotchas for the next session (same facts, for a reader who starts here)
- An over-limit withdrawal reaches Turnkey only if the user has more than that amount available and one vault address holds it on-chain. Crossroads locks funds first. Deposit 0.07 before demoing the refusal.
- A vault's app keys live beside STATE_PATH. Lose them and the vault is permanently unusable.
- Changing WITHDRAWAL_CAP or the chains does not update an existing vault's policies. Make a fresh vault.
- Turnkey mode with an old stand-in ledger refuses to start. Use a fresh STATE_PATH folder.
- The page is bundled into public/app.js, which is not committed. `npm run dev` bundles once.
- Set LIQUIDITY_PROVIDER to Will's account ID wherever the demo runs. Added liquidity cannot be withdrawn, so he should seed small amounts.
- Google sign-in needs each Crossroads address listed on the Google client, or Google refuses the sign-in.

## Lessons
- Local chains beat testnets for end-to-end checks: anvil with `--chain-id 11155111` and `--chain-id 84532`, with the RPC settings pointed at them. Playwright with headless Chromium is available in the workspace.
- Start long-running processes from a script file with setsid/nohup. A `pkill -f` whose pattern appears in the same command line kills the shell running it.
- App-level tests with stand-in network providers surfaced the deposit-scanner bug.
- Turnkey's policy language accepted `activity.type`, `wallet.id`, numeric `eth.tx.chain_id` and `eth.tx.value` in wei as written.
- Signing a test transaction with an absurd transaction number checks policies live without producing anything usable on-chain.
- Before building, walk Will through the user flow in plain terms. The design had drifted from his picture of a real app, and it only surfaced when he asked "what am I signed in as?"
