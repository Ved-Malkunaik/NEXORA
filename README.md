# Nexora: private AI on NEAR

A private AI assistant on NEAR. One chat, two kinds of privacy:

- **Hide what you ask (every chat).** Prompts run in a TEE on NEAR AI Cloud. The gateway verifies the attestation before sending your prompt, and every answer shows each check. **Working.**
- **Hide who pays (optional, per session).** Turn on "Pay privately with a note": buy a fixed-price note in public, then spend it with a zero-knowledge proof. The gateway verifies that a paid note backs your session without learning which account bought it. **Working**, with the limits listed below.
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
| Gateway metering and settlement | Real. The gateway charges what it metered, never more than the cap, and settles sessions the user abandons |
| Gateway caller authentication | Real. Every request is signed by a per-session chat key registered on-chain |
| TEE attestation (Intel TDX + NVIDIA GPU) | Real, fetched and verified live from NEAR AI Cloud, no API key needed |
| Model replies | Real once `NEARAI_API_KEY` is set in `gateway/.env`. Without it they are simulated and say so, and the proof panel shows "Not verified" |
| Reply signature check | Real. Each reply's signature is checked against the attested enclave key and the exact request and response bytes; verified live on testnet |
| Private payment (a note and a zero-knowledge proof) | Real on testnet. Semaphore v4 (Groth16) proofs made in the browser and verified by the gateway. This is the zkAPI idea built on NEAR, not the Ethereum zkAPI service. The proof is verified by the gateway, not on-chain |
| Send NEAR from chat (any session) | Real. "send 0.001 NEAR to alice.testnet" opens a confirmation, then your wallet. The transfer itself is public |
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

Check the TEE yourself, without any Nexora code in the path (fresh nonce, Intel and NVIDIA verification, and a real reply whose signature recovers to the attested enclave key):

```bash
cd gateway
node --env-file=.env scripts/verify-tee.mjs
```

To use your own contract, copy `.env.example` to `.env.local` and set `VITE_TESTNET_CONTRACT_ID`.

## How Level 0 works

- **Wallet:** `@near-wallet-selector/core` v10 with MyNearWallet, Meteor, HERE and Intear. The picker modal is our own (the stock modal pins React 18).
- **Account abstraction (session key):** the selector is set up with `createAccessKeyFor`, so sign-in adds a function-call access key that can only call `open_session` and `reclaim_session` on the credits contract. After that one approval, those calls need no wallet popup. Payable calls (`deposit`, `withdraw`) still go through the wallet, because function-call keys cannot attach deposits. The dashboard reads the key back from chain with `view_access_key_list`.
- **Network switch:** `src/config/networks.ts` is the single config map (network, contract ID, RPC). Switching rebuilds the selector in place, with no page reload, and keeps each network's login in separate storage. On testnet the Funding page shows "mainnet only", because NEAR Intents has no testnet.
- **Landing page:** the robot is built entirely in three.js 0.160 (`src/landing/robotScene.ts`). Scroll moves the camera from the full body to a close-up of the head, and the face switches to a quote mark in the last section.

## How Level 2 works

- **One client interface** ([src/client/types.ts](src/client/types.ts)) is all the screens talk to. It mirrors the deployed contract's JSON. Level 3 swaps the mock for the live contract, gateway, NEAR AI Cloud and Intents without touching the screens.
- **The mock** ([src/client/mock.ts](src/client/mock.ts)) enforces the contract's rules and error messages, streams chat replies with per-token metering, and produces TEE attestations and payment proofs, all labelled mock.
- **Try it without a wallet:** on any app page, choose *Explore with a demo account*. Everything is simulated and nothing touches the chain.
- **Developer panel** (Settings): simulate failures, move the mock clock forward to test expiry and reclaim, reset mock data.

## How Level 3 works

- **Live client** ([src/client/live.ts](src/client/live.ts)): the same interface as the mock, backed by the contract (wallet for payable calls, session key for `open_session` and `reclaim_session`) and the gateway. With a wallet connected the app is live; the demo account stays on the mock.
- **Gateway** ([gateway/src/server.js](gateway/src/server.js)): checks each session on-chain, meters per token, stops at the cap, and settles with a function-call key that can only call `settle_session`. It stores token counts, never prompts or replies.
- **Who is calling** ([gateway/src/auth.js](gateway/src/auth.js)): opening a session also registers a per-session chat key on-chain. The gateway accepts a chat or settle request only if that key signed it, so nobody else can spend or close your session. No extra wallet popup.
- **TEE attestation** ([gateway/src/nearai.js](gateway/src/nearai.js)): six checks before a prompt is sent, three more on the reply. The chat page lists each one with pass or fail, plus the raw quote so you can re-verify.
- **Private payment with notes** ([gateway/src/notes.js](gateway/src/notes.js), [src/client/zk.ts](src/client/zk.ts)):
  1. *Buy (public).* The browser makes a secret and sends its commitment on-chain as an extra argument of `open_session`, with the cap set to the fixed note price (0.02 NEAR = 1000 tokens). The gateway reads that transaction, settles the session at its full cap, and adds the commitment to a public list (`GET /v1/notes`).
  2. *Spend (anonymous).* The browser proves, in zero knowledge, that it knows the secret of one commitment in the list, without saying which. The proof carries a nullifier so a note cannot be spent twice, and is bound to a fresh signing key. The gateway verifies it and opens a 24-hour session with the note's token budget. No account id is sent, then or with any later request.
  3. The chat page shows each check the gateway ran and how many notes yours hides among.
- **Intents quotes** ([src/client/intents.ts](src/client/intents.ts)): live dry-run prices from the 1Click API.
- **Send NEAR from chat** ([src/lib/transferIntent.ts](src/lib/transferIntent.ts)): in any session, a clear request such as "send 0.001 NEAR to alice.testnet" is read by a strict parser in the browser, not by a model. The app checks the recipient exists, shows amount, recipient and network for confirmation, then opens the wallet. The request never reaches the gateway and costs no credits. Questions ("how do I send…?") still go to the model.

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
- A session paid from your credits is not anonymous: sessions, caps, spend and timing are public on-chain under your account. Pay privately with a note for that.
- **A private session hides you only among other note buyers.** Buying a note is public, so the payer of a private session is one of the accounts that bought notes. On testnet today that is a handful of notes, mostly from one account.
- Buying a note and spending it straight away lets the gateway match the two by timing. Buy ahead, spend later.
- Private payment does not hide your IP address or your prompt from the gateway, and requests inside one session are linkable to each other.
- What is left of a note when its session ends is not refunded.
- Sending NEAR from chat is an ordinary public transfer from your account.
- Deposits and withdrawals are public on-chain.
- Chat transcripts are stored unencrypted in your browser's localStorage.

Full list with severities: [security report](docs/SECURITY_REPORT.md).
