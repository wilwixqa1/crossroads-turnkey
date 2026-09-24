# T03 context (Sept 24, 2026)

Session 3 took Crossroads from a laptop app to a live app on Oasis ROFL testnet, signed in with Google, with a real Turnkey vault the app created for itself. Will's call with Bryce (Turnkey CEO) is next week. Session 4 starts from "What is next".

## How session 4 starts
Will pastes this file and says "let's begin session 4". Claude then:
1. clones github.com/wilwixqa1/crossroads-turnkey (public; no token needed to read);
2. reads docs/SOW.md and docs/BACKLOG.md;
3. asks Will for a GitHub token (to push and to start the deploy workflow). His Turnkey API key is needed only for changes in his main organization; nothing planned next needs it.

## Working with Will (read first)
- One chat is one session ("CR session N" = TN). Plain English in every reply: what changed and what it means for him. No file names or tooling internals.
- He does not read code, installs nothing locally, dislikes passkeys, and wants the demo to feel like a real app (no test-harness buttons in the trading screen; attack checks belong on the proof page).
- He pushes hard on precise claims. In T03 he caught an overstated privacy claim and asked whether the design matched the Crossroads paper. Check the sources before stating what a paper says; state caveats plainly.
- Ask before anything irreversible (the vault lock). He decided to wait on it.
- He wants to spend Turnkey's 25 free monthly signatures only on real walkthroughs: build and test on local chains first.

## Where things live
- Design: Claude Doc SoW https://claude.ai/code/artifact/6e5f1007-0475-40d2-96cd-7c38fbe43def, snapshot in docs/SOW.md.
- Live app: https://p8080.m1742.opf-testnet-rofl-9.rofl.app
  - ROFL app ID rofl1qrym7mrsn6kjxsj2rywtnn07scpkev73vsd43zwm, machine m1742 on the Oasis-run provider (oasis1qp2ens0hsp7gh23wajxa4hpetkdek3swyyulyrmz), 5 TEST per hour.
  - Paid until Sept 26 20:41 UTC (Saturday 4:41 PM Eastern). Top up before then or the next deploy rents a new machine: new address, empty ledger, Google origin to re-add.
- Deploy wallet (ROFL app admin): 0xd3bac6427A4702aCb3d6Ae3107402BE223c924C3 (oasis1qzqa7nucgaag7p9duqqprt3frwc0c8ghfvne9tu7), about 20 TEST left. Its key exists only as the repo secret DEPLOY_WALLET_KEY. Will funds it from MetaMask on Sapphire Testnet.
- Deploying: GitHub Actions, workflow "deploy", started by hand (Actions tab) or by the API with Will's token. Modes: deploy (build, register if needed, publish, run; commits the manifest and pinned image back to main), top-up (add hours), status. Each deploy to the same machine keeps the address and the saved ledger.
- Turnkey, Will's main org fa26e2cd-7656-4db6-b26f-3012c3b578e8:
  - crossroads-signup user (18dd4896-…) holds the enclave's sign-up key 020ef0f7…, with one policy: create sub-organizations and start logins only. Confirmed live: it was refused adding a policy.
  - Test_Policy (Will's, from exploring) and a test user CryptoSwim; both have no effect on the demo.
- Live vault: sub-org f5597296-aa58-40d5-a2b3-af454dda4fe9, "Crossroads vault 2026-09-24 06:12", created by the app itself through the sign-up key.
  - app-admin (only root, key 03b9de…) and app-signer (02bdbd…), both keys from ROFL's key service.
  - Two policies: withdrawals on Sepolia and Base Sepolia; deny above 0.05 ETH.
  - Address #0 = William Wendt's deposit address 0x0BeAc0e5b61A8DB1d211BB638f21dFf5AF2bCEA1, holding 0.1 Sepolia ETH.
- Users: William Wendt (sub-org c6ae2957…, account 0x03b5af4bc5e7a53cd45fc0001757058c24ccb1ec, 0.1 Sepolia ETH available); wil wix (sub-org 04f9058c…, account 0xbac4de4f…, not yet in the fresh ledger).
- Throwaway sub-orgs, nothing can sign for them: T02 vault b27be120; local-test vault db7ddd37; browser-signing checks 15cda38f and c650228a; sealed test vault aa1cb620.
- Google client: SimpleBlueprints' client; the ROFL address is in its Authorized JavaScript origins.

## What session 3 did
1. Deploys through GitHub Actions, with the Oasis CLI run on GitHub. The first deploy registered the app (100 TEST deposit) and rented the machine. The image package on GitHub came out public on its own.
2. One Withdraw button. Try to break it and the app's own limit are gone; the vault's policy is the only limit.
3. Google sign-in:
   - the browser makes a session key that cannot be copied out, and Google's token is bound to it (nonce = sha256 of the key's hex text);
   - the app, with its sign-up key, finds or creates the user's sub-org and wallet, then opens an 8-hour session;
   - every request is then signed by the user's Turnkey wallet from the browser. Confirmed live end to end.
4. Phase 3:
   - the app takes its three Turnkey keys from ROFL's key service;
   - on first start it creates its own vault with the sign-up key, sets up wallet, signer and policies as admin, and finds the vault again by its admin key after a restart or machine move (tested by erasing the saved vault ID);
   - the page says "being set up" while it waits.
   - Registering a new sign-up key removes every older one.
5. Deposits:
   - rpc.sepolia.org is dead, and an unanswered second-opinion check had been treated as "not a deposit", so Will's 0.1 was skipped;
   - fixed: the check now retries, and fallback providers are tried in order;
   - added crediting a missed deposit by its transaction, still two-provider checked and credited once;
   - Will's 0.1 was credited that way.
6. Demo annotations, built before the full run to save signatures:
   - every Turnkey step names the key that acted (your wallet, vault signer, vault admin, sign-up key) with its activity ID;
   - withdrawals name the allowing or denying policy;
   - a "What just happened" card follows the latest action.
   - Tested on local chains; live. Will's 0.07 refusal showed on the page and in the vault's Activities with the same ID.
7. Vault lock tested on a throwaway vault. After it, the admin's actions sit at "Consensus needed" forever, the signer still adds addresses and signs under the cap, and 0.06 is still refused. Not applied to the live vault.
8. 35 tests, CI green.

## Decisions (Sept 24)
- Stay on the Oasis-run provider at 5 TEST per hour and keep this machine alive. A cheaper third-party provider (50 TEST per month) was found and declined.
- Per-network limits: 0.05 on Sepolia, 0.02 on Base Sepolia (not built yet).
- Don't lock the vault yet.
- Keep per-user deposit addresses and several vault addresses. These are the paper's optional add-ons, not its base design. Framing for Bryce: the demo uses the paper's per-user deposit address and multi-address optimizations, with Turnkey as the signing committee and a verified ROFL app standing in for the backend chain.
- Privacy claims, corrected against the Crossroads paper (arXiv 2607.06525):
  - deposits and withdrawals are public;
  - trades and transfers inside Crossroads are private;
  - the paper claims the same.
  - Per-user addresses do not make it better. A shared address would not hide whose deposit is whose either, since the paper's deposit tag names the account.
- The Aave-through-the-vault idea is our extension, not the paper's. The paper puts lending on its backend chain. Kept as a talking point.

## What is next (T04)
See docs/BACKLOG.md "Next up":
1. Will finishes the live run: wil wix signs in, send 0.01, withdraw 0.01. The first successful vault-signed withdrawal on a real network.
2. Per-network limits.
3. The proof page with live checks.
4. The Base Sepolia run and pool seeding.
5. A recorded rehearsal, then machine top-ups through the call.

## Waiting on Will
- TEST top-ups: about 120 per day of uptime through the call.
- About 0.1 Base Sepolia ETH.
- The live run steps above.
- Optional: an Alchemy key; the billing check on Turnkey's usage page (about 5 completed signatures expected).

## Code comments
Written during the session, in new or changed code (all start NEXT PERSON):
- src/app.ts, withdraw request step: no app-side limit on purpose; don't add one back.
- src/app.ts, withdrawal send step: the funds check wording (existing comment updated for over-limit withdrawals).
- src/chains/config.ts, Sepolia providers: rpc.sepolia.org is dead; providers after the first are tried in order; a keyed provider is sturdier.
- src/signer/keys.ts, key names: the names are the keys; never rename them.
- src/server.ts, vault start-up: on a first ROFL start, "not ready" is normal until the sign-up key is registered.
- src/auth/google.ts, wallet creation: no email, phone or recovery on user wallets.
- web/google.ts, nonce: Turnkey hashes the key's hex text, not its bytes.
- web/google.ts, signing: use the checksummed address; Turnkey matches addresses case-sensitively.
- .github/workflows/deploy.yml, image step: compose.yaml has exactly one image line, which the workflow rewrites.

Close-out comments commit (3 lines added, 0 removed):
- .github/workflows/deploy.yml, deploy step: a lapsed machine gets replaced with a new address and an empty ledger; top up first.
- web/main.ts, submit: the page's action ref must match the app's (req:<lowercase account>:<seq>) or the card never fills.

## Gotchas for the next session
- Temporary scripts must sit inside the repo folder (as *.tmp.mts, then deleted) to import the project's modules; from /tmp they fail to resolve packages.
- `pkill -f <pattern>` kills the shell running it when the pattern is in the same command line (bit us again). Find the process by its PORT environment variable under /proc instead.
- The Oasis CLI needs `</dev/null` and `-y` in scripts. `oasis rofl machine logs` still prompts for a passphrase and fails with EOF, so live logs are not readable from the workspace yet.
- Deploy wallet admin work from the workspace needs the key imported into the local Oasis CLI, and the key only exists in the GitHub secret. Next session, work through the deploy workflow's modes instead.
- Visiting the Google sign-in screen resets the browser's session key (a fresh key per sign-in). Tests that pre-register a key must avoid loading that screen.
- The refused-signature activity ID on the page is looked up as "the newest rejected signature in the vault". Two refusals at the same moment could swap IDs (display only).
- The vault admin is still root with quorum 1: anything done with it succeeds. Never use it for a "refusal" demo.
- Moving machines keeps the vault and the enclave keys (they belong to the app ID) but not the ledger.

## Lessons
- Test on local chains (anvil with the Sepolia and Base Sepolia chain IDs) and with the stand-in vault before spending Turnkey signatures. Refusals are free; completed signatures count.
- A second-opinion check must fail loudly (retry), never silently read "no".
- Read the paper before describing it. The SoW's summaries were right about the add-ons but led to overstated privacy claims.
