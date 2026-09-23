# Crossroads on Turnkey

A working demo of [Crossroads](https://arxiv.org/abs/2607.06525), the chain-abstracted exchange design from Cornell Tech, rebuilt with **Turnkey** as the signing layer and an **Oasis ROFL** app as the verifiable ledger.

Users hold one balance that spans chains. Trades and transfers settle instantly on an off-chain ledger. Only deposits and withdrawals touch a blockchain, and every withdrawal is signed by Turnkey under policies no person can override. The design follows the key-encumbrance rules of the [Liquefaction](https://arxiv.org/abs/2412.02634) paper.

## How it is put together

| Part | Job | Where |
| --- | --- | --- |
| Ledger | Balances, deposits credited once, lock-before-sign withdrawals, swap pool, replay protection | `src/ledger/` |
| Vault | Owns deposit addresses and signs withdrawals. Local stand-in now; Turnkey in Phase 1 | `src/signer/` |
| Chains | Finds deposits (two providers must agree), sends withdrawals, reports real fees | `src/chains/` |
| App | Wires the above together and runs the background loops | `src/app.ts` |
| Server | JSON API and the web page | `src/server.ts`, `public/` |

## Run it on a laptop

```
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:8080. Tests: `npm test`.

## Status

Phase 2 groundwork: ledger, request signing, deposit scanning, and withdrawal flow, all against Sepolia and Base Sepolia public endpoints with a stand-in vault. The Turnkey vault, passkey sign-up, the trading page, and the ROFL packaging follow the phase plan in the project's Scope of Work.
