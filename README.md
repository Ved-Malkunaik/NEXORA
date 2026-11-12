# Nexora: private AI on NEAR

A chat app where you choose which privacy axis to protect:

- **Mode A: hide who pays.** Requests are paid with zkAPI credits.
- **Mode B: hide what you ask.** Prompts run in a TEE on NEAR AI Cloud, and the UI shows the attestation.
- **Funding:** top up from NEAR or stablecoins through NEAR Intents (mainnet only).

Built for the NEAR Hackathon 2026, privacy track.

## Status

| Level | Scope | State |
|---|---|---|
| 0 | Landing page (3D robot), navbar, app shell, wallet connect, session key, mainnet/testnet switch | Done |
| 1 | Credits contract (Rust), tests, security pass | Contract, tests, security report and gateway stub done; testnet deploy needs your account |
| 2 | Every screen final, on mock data | Planned |
| 3 | Contract and gateway wired to the UI | Planned |

## Run it

```bash
npm install
npm run dev
```

Open the printed URL, click **Connect wallet**, and pick a wallet. The app starts on testnet.

To use your own contract, copy `.env.example` to `.env.local` and set `VITE_TESTNET_CONTRACT_ID`.

## How Level 0 works

- **Wallet:** `@near-wallet-selector/core` v10 with MyNearWallet, Meteor, HERE and Intear. The picker modal is our own (the stock modal pins React 18).
- **Account abstraction (session key):** the selector is set up with `createAccessKeyFor`, so sign-in adds a function-call access key that can only call `open_session` and `reclaim_session` on the credits contract. After that one approval, those calls need no wallet popup. Payable calls (`deposit`, `withdraw`) still go through the wallet, because function-call keys cannot attach deposits. The dashboard reads the key back from chain with `view_access_key_list`.
- **Network switch:** `src/config/networks.ts` is the single config map (network, contract ID, RPC). Switching rebuilds the selector in place, with no page reload, and keeps each network's login in separate storage. On testnet the Funding page shows "mainnet only", because NEAR Intents has no testnet.
- **Landing page:** the robot is built entirely in three.js 0.160 (`src/landing/robotScene.ts`). Scroll moves the camera from the full body to a close-up of the head, and the face switches to a quote mark in the last section.

## Docs

- [Workflow](docs/WORKFLOW.md): how a session goes from deposit to settlement
- [Contract spec](docs/CONTRACT_SPEC.md): state, functions, limits, security properties
- [Security report](docs/SECURITY_REPORT.md): audit checklist, tools run, findings
- [Contract README](contract/README.md): build, test, deploy

## Project layout

```
src/
  config/networks.ts      network config map + session-key methods
  wallet/                 NearProvider (selector lifecycle), useNear, useAccountInfo
  lib/rpc.ts              RPC helpers: balance, access keys
  landing/                landing page, 3D robot scene, copy
  components/             navbar, wallet modal, layouts, session-key card
  pages/                  Dashboard, Chat, Funding, Receipts, Settings
contract/                 Rust credits contract (near-sdk 5.30), unit + sandbox tests
gateway/                  Node stub: reads sessions, settles them with a receipt hash
docs/                     workflow, contract spec, security report
```

## Deploy

Any static host works. `vercel.json` rewrites all routes to `index.html` for client-side routing.

## Privacy limits

These will be expanded as the features land:

- The funding deposit is public on-chain.
- Mode B hides the prompt from the model provider, but it does not make payment anonymous.
- zkAPI does not hide your IP address or the prompt contents.
