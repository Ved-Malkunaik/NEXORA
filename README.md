# Nexora: private AI on NEAR

A chat app where you choose which privacy axis to protect:

- **Mode B: hide what you ask.** Prompts run in a TEE on NEAR AI Cloud. The gateway verifies the attestation before sending your prompt, and the UI lists every check. **Working.**
- **Mode A: hide who pays.** Planned with zkAPI credits. **Not implemented: a labelled preview only.** Payment is still linked to your account.
- **Funding:** deposit NEAR directly. Stablecoin top-ups show real NEAR Intents (1Click) dry-run prices; executing the swap is not wired.

Built for the NEAR Hackathon 2026, privacy track.

## Status

| Level | Scope | State |
|---|---|---|
| 0 | Landing page (3D robot), navbar, app shell, wallet connect, session key, mainnet/testnet switch | Done |
| 1 | Credits contract (Rust), tests, security pass, gateway stub | Done. Live on testnet at `credits.vedd.testnet` |
| 2 | Every screen final, on mock data | Done. UI frozen; runs on a typed mock client (`src/client`) |
| 3 | Contract and gateway wired to the UI | Done on testnet. Real deposits, sessions, metering and settlement; real TEE attestation; signed gateway requests; real Intents quotes |

What is real and what is not, exactly:

| Piece | State |
|---|---|
| Credits contract: deposit, withdraw, open, settle, reclaim, receipts | Real, on testnet |
| Gateway metering and settlement | Real. The gateway charges what it metered, never more than the cap |
| Gateway caller authentication | Real. Every request is signed by a per-session chat key registered on-chain |
| TEE attestation (Intel TDX + NVIDIA GPU) | Real, fetched and verified live from NEAR AI Cloud, no API key needed |
| Model replies | Real once `NEARAI_API_KEY` is set in `gateway/.env`. Without it they are simulated and say so, and the proof panel shows "Not verified" |
| Reply signature check | Real. Each reply's signature is checked against the attested enclave key and the exact request and response bytes; verified live on testnet |
| Mode A (zkAPI) | Not implemented. Preview only |
| Send NEAR from chat (Mode A sessions) | Real. "send 0.001 NEAR to alice.testnet" opens a confirmation, then your wallet. The transfer is public; it is not a zkAPI payment |
| NEAR Intents | Real dry-run prices. No swap execution |

## Run it

```bash
npm install
npm run dev
```

Open the printed URL, click **Connect wallet**, and pick a wallet. The app starts on testnet.

For live chat and settlement, run the gateway in a second terminal:

```bash
cd gateway
npm install
cp .env.example .env    # set CONTRACT_ID, GATEWAY_ACCOUNT_ID, GATEWAY_PRIVATE_KEY, optionally NEARAI_API_KEY
npm start
```

Check the whole flow on testnet without the browser (needs near-cli-rs with your key in the keychain):

```bash
cd gateway
npm run smoke -- <your-account>.testnet
```

To use your own contract, copy `.env.example` to `.env.local` and set `VITE_TESTNET_CONTRACT_ID`.

## How Level 0 works

- **Wallet:** `@near-wallet-selector/core` v10 with MyNearWallet, Meteor, HERE and Intear. The picker modal is our own (the stock modal pins React 18).
- **Account abstraction (session key):** the selector is set up with `createAccessKeyFor`, so sign-in adds a function-call access key that can only call `open_session` and `reclaim_session` on the credits contract. After that one approval, those calls need no wallet popup. Payable calls (`deposit`, `withdraw`) still go through the wallet, because function-call keys cannot attach deposits. The dashboard reads the key back from chain with `view_access_key_list`.
- **Network switch:** `src/config/networks.ts` is the single config map (network, contract ID, RPC). Switching rebuilds the selector in place, with no page reload, and keeps each network's login in separate storage. On testnet the Funding page shows "mainnet only", because NEAR Intents has no testnet.
- **Landing page:** the robot is built entirely in three.js 0.160 (`src/landing/robotScene.ts`). Scroll moves the camera from the full body to a close-up of the head, and the face switches to a quote mark in the last section.

## How Level 2 works

- **One client interface** ([src/client/types.ts](src/client/types.ts)) is all the screens talk to. It mirrors the deployed contract's JSON. Level 3 swaps the mock for the live contract, gateway, NEAR AI Cloud and Intents without touching the screens.
- **The mock** ([src/client/mock.ts](src/client/mock.ts)) enforces the contract's rules and error messages, streams chat replies with per-token metering, and produces Mode B attestations and Mode A payment proofs, all labelled mock.
- **Try it without a wallet:** on any app page, choose *Explore with a demo account*. Everything is simulated and nothing touches the chain.
- **Developer panel** (Settings): simulate failures, move the mock clock forward to test expiry and reclaim, reset mock data.

## How Level 3 works

- **Live client** ([src/client/live.ts](src/client/live.ts)): the same interface as the mock, backed by the contract (wallet for payable calls, session key for `open_session` and `reclaim_session`) and the gateway. With a wallet connected the app is live; the demo account stays on the mock.
- **Gateway** ([gateway/src/server.js](gateway/src/server.js)): checks each session on-chain, meters per token, stops at the cap, and settles with a function-call key that can only call `settle_session`. It stores token counts, never prompts or replies.
- **Who is calling** ([gateway/src/auth.js](gateway/src/auth.js)): opening a session also registers a per-session chat key on-chain. The gateway accepts a chat or settle request only if that key signed it, so nobody else can spend or close your session. No extra wallet popup.
- **TEE attestation** ([gateway/src/nearai.js](gateway/src/nearai.js)): six checks before a prompt is sent, three more on the reply. The chat page lists each one with pass or fail, plus the raw quote so you can re-verify.
- **Intents quotes** ([src/client/intents.ts](src/client/intents.ts)): live dry-run prices from the 1Click API.
- **Send NEAR from chat** ([src/lib/transferIntent.ts](src/lib/transferIntent.ts)): in a Mode A session, a clear request such as "send 0.001 NEAR to alice.testnet" is read by a strict parser in the browser, not by a model. The app checks the recipient exists, shows amount, recipient and network for confirmation, then opens the wallet. The request never reaches the gateway and costs no credits. Questions ("how do I send…?") still go to the model.

## Testnet deployment

| Role | Account |
|---|---|
| Contract | [`credits.vedd.testnet`](https://testnet.nearblocks.io/address/credits.vedd.testnet) |
| Owner | `vedd.testnet` |
| Gateway (only account that can settle) | `gateway.vedd.testnet` |

Deployed from commit `43adcd9` (wasm sha256 `0799b236c165b9b9…`), after CI passed every job (fmt, clippy, 54 unit tests, 4 sandbox integration tests, audit).
Smoke test on testnet: deposit 0.2 NEAR → open session (cap 0.05) → settle by a non-gateway account rejected → gateway settles 0.01 (0.04 refunded) → second settle rejected → receipt stored with hash only.

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
gateway/                  Node service: session auth, metering, NEAR AI Cloud + attestation, settlement
docs/                     workflow, contract spec, security report
```

## Deploy

Any static host works. `vercel.json` rewrites all routes to `index.html` for client-side routing.

## Privacy limits

- **The gateway operator sees your prompts.** The TEE hides them from the model provider, not from the gateway.
- You trust the gateway's attestation checks unless you re-verify the raw quote yourself.
- Mode B does not make payment anonymous: sessions, caps, spend and timing are public on-chain under your account.
- Mode A is not implemented, so nothing hides who pays today.
- Sending NEAR from chat is an ordinary public transfer from your account. zkAPI would hide who pays for AI requests; it would not hide a transfer.
- Deposits and withdrawals are public on-chain.
- Chat transcripts are stored unencrypted in your browser's localStorage.

Full list with severities: [security report](docs/SECURITY_REPORT.md).
