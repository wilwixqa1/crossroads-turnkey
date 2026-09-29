# T04 context (Sept 28-29, 2026)

Session 4 built and tested everything left for the Bryce call on local copies of both networks, and checked every vault rule on real Turnkey. Nothing is deployed: the machine lapsed on Sept 26. The call is Thursday Oct 1 (time not yet known). Session 5 starts from "What is next".

## How session 5 starts
Will pastes this file and says "let's begin session 5". Claude then:
1. clones github.com/wilwixqa1/crossroads-turnkey;
2. reads docs/SOW.md and docs/BACKLOG.md;
3. asks Will for a GitHub token (push and deploy), whether the deploy wallet has its TEST, and the call time. His Turnkey key is needed only for the rules check (`npm run turnkey:rules`), which nothing planned requires.

## Working with Will (read first)
- One chat is one session. Plain English in every reply: what changed and what it means for him. No file names or tooling internals.
- He does not read code and installs nothing locally. He wants the demo to feel like a real app; attack checks live on the proof page.
- He pushes hard on precise claims. Say what was tested and what is inferred (T04: "an erroring allow does not block a signature" was tested; "an erroring deny would not apply" was not).
- Anything created only to test in his Turnkey org is named "Throwaway: …" and deleted when done (his standing rule; also in docs/WORKFLOW.md).
- Ask before anything irreversible (the vault lock, still not applied).
- Spend Turnkey signatures only on real walkthroughs; test locally or with free refusals first.

## Where things live
- Design: Claude Doc SoW https://claude.ai/code/artifact/6e5f1007-0475-40d2-96cd-7c38fbe43def (rev 87), snapshot in docs/SOW.md.
- Live app: none. The deploy workflow's status mode (free) reports "Machine instance not found"; the next deploy rents a new machine with a new address (it passes --replace-machine).
  - ROFL app ID rofl1qrym7mrsn6kjxsj2rywtnn07scpkev73vsd43zwm, 100 TEST staked, Oasis-run provider at 5 TEST per hour.
  - The enclave keys and the vault survive a machine move; the ledger does not, which is what the restore below is for.
- Deploy wallet (ROFL app admin): 0xd3bac6427A4702aCb3d6Ae3107402BE223c924C3, 19.9 TEST on Sept 28. Key only in the repo secret DEPLOY_WALLET_KEY. Workflow "deploy": modes deploy, top-up, status; dispatch by API with the token.
- Turnkey, Will's main org fa26e2cd-7656-4db6-b26f-3012c3b578e8:
  - crossroads-signup user: the enclave's sign-up key, one policy (create sub-orgs, start logins).
  - Test_Policy and the CryptoSwim user are Will's own; he may delete them.
  - Will's API key: the private half he gave belongs to public key 02d23d9a9946dd80ca3656c733b7fb1ec34a29ba857a13141327093b1ebe979d9a (user Wilwixq). The 03944af1… key he pasted as "public" is a different key.
- Live vault: sub-org f5597296-aa58-40d5-a2b3-af454dda4fe9 (app-admin root 1 of 1, app-signer).
  - It still has the old two rules (single 0.05 cap, any contract call). The first start of the new version replaces them with nine: withdrawal allow and cap deny per network, Aave supply, Aave withdraw and gateway approve on Base Sepolia, never borrow. It also uploads four Aave contract interfaces.
  - Address #0 0x0BeAc0e5b61A8DB1d211BB638f21dFf5AF2bCEA1 holds William Wendt's 0.1 Sepolia ETH (checked Sept 28). #1 0x0D7Bb399D1FF2138Bc023934b8F462d823CcF0dC (wil wix) is empty.
- User sub-orgs: William Wendt c6ae2957 (account 0x03b5af4bc5e7a53cd45fc0001757058c24ccb1ec); wil wix 04f9058c (account 0xbac4de4f8241e6340d75affc454953ab50fa203b).
- Old throwaway sub-orgs nobody can delete (only a sub-org's own root key can; theirs were discarded), all empty: b27be120, db7ddd37, 15cda38f, c650228a, aa1cb620. The T04 rules-check vault was deleted.
- Will's MetaMask 0x45bed4052fcb20c25c2479038d4f21510e75d825: a plain wallet on both networks, 0.15 Base Sepolia ETH.
- Aave v3 Base Sepolia, from the official address book: Pool 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27, WETH gateway 0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6, aWETH 0x73a5bB60b0B0fc35710DDc0ea9c407031E31Bdbb.

## What session 4 did
1. Fixes from Will's live testing:
   - an expired Google sign-in returns to Continue with Google with a plain message, and never spends a signature;
   - Send checks the recipient before the wallet signs, shows "Sending to <name>", and accepts a Crossroads deposit address;
   - activity IDs show like Turnkey's dashboard (first 4 and last 4).
2. Restore after the machine loss: on first sign-in, William Wendt and wil wix get their old deposit addresses back and William's 0.1 deposit is credited again by its transaction (RESTORE_ACCOUNTS in compose.yaml). Will's account is the only liquidity provider.
3. Per-network limits: 0.05 on Sepolia, 0.02 on Base Sepolia.
   - Withdrawals are plain ETH transfers only: the rule requires 21,000 gas, so the vault cannot call a contract through a withdrawal.
   - Withdrawals to a contract or smart account (including EIP-7702 wallets) are refused before signing.
   - A reverted withdrawal charges its real fee.
4. The app keeps the vault's signer rules in step on every start (create new, then delete old; same-named rules replaced in place). If Turnkey refuses, the vault runs on its old rules and the proof page shows the problem.
5. Proof page at /proof, no sign-in:
   - code version, from the manifest the deploy commits;
   - who controls the vault and the sign-up key, read live from Turnkey;
   - solvency, including aWETH;
   - the vault's signing history;
   - five live checks: export, wrong network, borrow, sign-up key, replay. All are refusals, so all are free.
6. Earn on Base Sepolia:
   - pooled Aave supply from the vault, with per-user shares on the ledger;
   - an Earn tab and an Earning on Aave column that visibly grows;
   - the first Stop earning from an address takes two vault signatures (approve, withdraw);
   - each Turnkey step shows how the call was read and which rule allowed it.
7. Base's L1 data fee is now charged. Before this, the ledger drifted a few gwei per Base transaction and the proof page read "Short".
8. Every rule checked on real Turnkey on a throwaway vault, since deleted:
   - every allow, deny and refusal behaves as intended;
   - one real signature confirmed a withdrawal still signs alongside the Aave rules;
   - four problems fixed on the way: unnamed ABI parameters, the combined Aave rule erroring, unique rule names, and address case (which turned out fine).
9. Design doc (rev 87) and backlog updated. The call is Oct 1. Talking points prepared in chat:
   - Turnkey Earn vs the demo's pooled Earn;
   - free rule testing with policy evaluations;
   - no short-circuit and the deny-rule edge;
   - the 21,000-gas clause;
   - ABI friction;
   - the solvency check catching the L1 fee.
10. 60 tests, CI green.

## Decisions (Sept 28)
- Earn runs on Base Sepolia: Aave's Sepolia WETH market paid 0%, Base Sepolia's about 2.3%.
- Withdrawals are plain transfers only (21,000 gas) and go only to plain wallets.
- Deploy once, when Will can do the live run right after. A day of slack before the call.
- Solana (Will asked Sept 29 whether there is time for it, given the Oct 1 date): only after a clean Ethereum live run, as deposits and withdrawals only (no swap or Earn), tested on a local Solana chain, deployed Wednesday morning. If it is not solid by Wednesday noon it stays the closing talking point, so the rehearsal runs on tested code.

## What is next (T05)
1. Will: about 200 TEST in the deploy wallet, the pay-as-you-go card on Turnkey, and the call time (sets the hours to buy).
2. Deploy (workflow mode deploy). Watch the log for "Created policy" lines, or read the proof page's policy problem line. Will adds the new address to the Google client's Authorized JavaScript origins.
3. Live run, following docs/BACKLOG.md "Live run". Then delete the "deposits" list from RESTORE_ACCOUNTS once William's 0.1 shows credited.
4. Solana, if the live run was clean (see Decisions). A sketch to verify against Turnkey's docs first:
   - a Solana account in the vault wallet per user (ADDRESS_FORMAT_SOLANA, path m/44'/501'/N'/0');
   - deposits found per deposit address;
   - withdrawals signed as TRANSACTION_TYPE_SOLANA, with a solana.tx rule limiting the amount and allowing only the System Program transfer;
   - a third balances row.
5. Recorded rehearsal Wednesday, then top-ups through the call.

## Waiting on Will
- About 200 TEST in the deploy wallet before the deploy.
- The pay-as-you-go card on Turnkey before the rehearsal (signatures used: about 9 of the free 25).
- The call time on Oct 1.
- The new machine's address in the Google client, right after the deploy.

## Code comments
Written during the session (all start NEXT PERSON):
- src/signer/turnkey.ts, vault start: a failed rules update must not stop the vault from opening; the old rules stay in force.
- src/signer/turnkey.ts, refused-activity lookup: it is "the newest rejected activity of this type", so two refusals at once could swap IDs (display only).
- src/signer/policy.ts, Aave rules: Turnkey does not short-circuit; each allow reads only its own function's arguments and the deny reads none.
- src/setup/turnkey-rules-check.ts: the throwaway vault is deleted at the end; never discard its keys before the delete.

Close-out comments commit (6 lines added, 0 removed):
- src/chains/evm.ts, fee paid: a local anvil fork of Base charges the L1 fee without reporting it; start it with --network ethereum.
- src/signer/policy.ts, evaluate: the rule set is written twice (Turnkey policies and the stand-in); change both, then run the rules check.
- compose.yaml, RESTORE_ACCOUNTS: delete the deposits list once the 0.1 is credited live, or a later empty ledger would credit it again.

## Gotchas for the next session
- Background processes die between turns, and a plain `&` or nohup hangs the tool call. Start with `(setsid cmd < /dev/null > log 2>&1 & echo $! > pidfile)` and stop by PID.
- Never kill by pattern: a pattern in the same command line matches the tool's own shell (it happened again with anvil).
- Local chains:
  - Sepolia: `anvil --port 8545 --chain-id 11155111 --fork-url https://ethereum-sepolia-rpc.publicnode.com`.
  - Base Sepolia: `anvil --port 8546 --chain-id 84532 --network ethereum --fork-url https://base-sepolia-rpc.publicnode.com`.
  - Forks give real Aave. App settings: SEPOLIA_RPC_URLS and BASE_SEPOLIA_RPC_URLS pointing twice at the fork, confirmations 1, VAULT_MODE=local, LOGIN_MODE=standin.
- Anvil's well-known test addresses (0x7099…79C8 and others) are EIP-7702 smart accounts on Sepolia. Withdrawals to them are refused; use a fresh address.
- Turnkey rate-limits bursts ("Resource exhausted", error 8) after a few dozen calls a minute. Space scripted calls about 1 s apart.
- Headless browser tests: Python Playwright is installed; `python3 -m playwright install chromium` once per workspace.
- The proof page's sign-up-key check only works on the live machine (the sign-up key lives in the enclave). Export is refused, and shows as a rejected activity (confirmed on the throwaway vault).
- The vault admin is still root with quorum 1: anything done with it succeeds. Never use it for a refusal.

## Lessons
- Test Turnkey rules on real Turnkey before a deploy: add a refuse-everything rule and read getPolicyEvaluations. It is free, and it caught three problems local tests could not.
- Check every fee a chain charges against the real balance change, not just gas times price. Base's L1 fee made the solvency check fail.
- Check a testnet market's live rate before building a yield demo on it.
- Say which parts of a claim were tested.
