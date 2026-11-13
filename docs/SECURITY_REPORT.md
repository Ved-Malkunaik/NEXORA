# Nexora credits contract: security report

Scope: [`contract/src/lib.rs`](../contract/src/lib.rs) at the Level 1 commit, `near-sdk` 5.30.1.
Method: the four-phase audit workflow of NEAR's `near-contract-audit` agent skill
(automated tools, manual review, finding-by-finding analysis, report), plus the security
checklist from the build plan.

## Automated analysis

| Tool | Result |
|---|---|
| `cargo clippy --all-features --lib --tests -W clippy::all -W clippy::nursery` | Clean. Two lints are allowed on the `#[near]` impl because the macro triggers false positives (`use_self` on `#[init]`, `missing_const_for_fn` on callbacks) |
| `cargo fmt --check` | Clean |
| `cargo audit` | One advisory (RUSTSEC-2026-0387, `crypto-bigint`), **not reachable on-chain** (see I-1). One unmaintained warning (`wee_alloc`, see I-2) |
| Unit tests (`cargo test --lib`) | 54 pass, including 2 property tests (`proptest`) on the settle arithmetic and the ledger invariant |
| Sandbox integration tests (`tests/integration.rs`) | Run in CI on Ubuntu. The NEAR sandbox has no Windows build |

## Detector checklist (near-contract-audit)

| Severity | Detector | Status | Evidence |
|---|---|---|---|
| High | `non-private-callback` | ✅ | `on_withdraw`, `on_unregister` and `on_fees_withdrawn` are `#[private]`. The integration test calls `on_withdraw` from a user and expects "is private" |
| High | `reentrancy` | ✅ | Every transfer debits state first. Callbacks only re-credit on failure. No state is read after a promise without the callback |
| High | `incorrect-argument-or-return-types` | ✅ | All 64/128-bit values cross JSON as `U64` or `NearToken` (strings). Only the `u32` limits in `get_config` are native |
| High | `unsaved-changes` | ✅ | `near_sdk::store::LookupMap` with `get_mut`, flushed when state is written. Unit tests read back through the map |
| High | `owner-check` | ✅ | `assert_owner()` on `set_gateway`, `set_paused`, `set_owner` and `withdraw_fees`. Settle is gateway-only, reclaim is session-owner-only. All tested |
| High | `yocto-attach` | ✅ | `withdraw`, `unregister` and all admin calls require exactly 1 yocto. Tested with 0 and 2 yocto, and with a function-call key in the sandbox |
| High | `storage-collision` | ✅ | `BorshStorageKey` enum gives distinct prefixes (`Accounts`, `Sessions`) |
| High | `required-initialization-macro` | ✅ | `#[init] new` plus `PanicOnDefault` |
| Medium | `gas-griefing` | ✅ | No unbounded loops: ≤ 4 open sessions and ≤ 20 receipts per account. No iteration over all accounts |
| Medium | `insecure-random` | ✅ n/a | No randomness |
| Medium | `prepaid-gas` | ✅ | Callbacks reserve a static 10 TGas and only touch one account entry |
| Low | `cover-storage-cost` | ✅ | A 0.05 NEAR reserve is taken on registration. A unit test fills a worst-case account (64-char id, 4 sessions, 20 receipts) and asserts its cost stays under the reserve |
| Low | `unsafe-math` | ✅ | `checked_*` with explicit errors on user paths, `saturating_*` in callbacks, and `overflow-checks = true` in release |
| Low | `float-math` | ✅ n/a | Integers only |

## Plan checklist

- [x] Access control on `settle_session`, `set_gateway` and `pause`.
- [x] Checked integer math, no overflow.
- [x] State updated before any transfer. State restored if the transfer promise fails
      (`on_withdraw`, `on_unregister` and `on_fees_withdrawn`, each unit-tested with `PromiseError::Failed`).
- [x] Exactly 1 yoctoNEAR on `withdraw`.
- [x] Session state machine: closed sessions are deleted, so double settle, settle after reclaim,
      and reclaim after settle all fail. The settle window (`≤ expires_at + 15 min`) and the reclaim
      window (`> expires_at + 15 min`) do not overlap. Boundary is tested at exactly the deadline.
- [x] Bounded storage per user, with storage staking covered by the reserve.
- [x] A gateway key compromise is bounded by caps and expiry. The gateway can only move
      `spent ≤ cap` of open sessions into the fee pool. It cannot touch `available`, and it cannot
      withdraw (fees go only to the owner).
- [x] `cargo clippy`, `cargo audit`, `proptest`, plus this AI-assisted review.
      **A second human reviewer is still recommended before mainnet.**

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| M-1 | Medium | **The gateway is trusted for the amount spent.** It can settle any open session at its full cap even if little was used. | Accepted for the hackathon. Each user sets their own cap, and the README discloses this. A fix would need signed usage receipts from NEAR AI Cloud verified on-chain |
| M-2 | Medium | **No upgrade path.** There is no `migrate` method, so fixing a bug means deploying to a new account. | Accepted for the prototype. Add `#[init(ignore_state)] migrate` before mainnet |
| L-1 | Low | **`set_owner` is a one-step transfer.** A typo hands control to the wrong account. | Accepted. A two-step propose/accept is an easy upgrade |
| L-2 | Low | **The session key's allowance is set by the wallet,** typically 0.25 NEAR of gas. Many `open_session` calls could exhaust it and force a reconnect. | UX only, no funds at risk |
| I-1 | Info | `crypto-bigint` RUSTSEC-2026-0387 comes only through `near-vm-runner` (unit-test mocks). `cargo tree --target wasm32-unknown-unknown -e normal` shows it is absent from the wasm. | Ignored in `contract/.cargo/audit.toml` with this justification |
| I-2 | Info | `wee_alloc` (unmaintained) is the default wasm allocator in `near-sdk` 5. | Tracked upstream. Revisit if near-sdk changes its default |
| I-3 | Info | The receipt hash format (lowercase sha256 hex) is checked, but not its link to real usage data. | By design: privacy over verifiability |

No High findings are open.

## Gateway and app (Level 3)

Scope: [`gateway/src`](../gateway/src) and [`src/client`](../src/client). Method: manual review plus
unit tests (`cd gateway && npm test`, 22 tests) and a scripted testnet run (`gateway/scripts/smoke.mjs`).

### What is enforced

| Property | How | Evidence |
|---|---|---|
| Only the session owner can spend or settle a session through the gateway | The browser generates an ed25519 chat key per session and registers its public key on-chain as an extra `client_key` argument of `open_session` (the contract ignores unknown args, so no contract change). The gateway reads that transaction once, checks signer, receiver, method and returned session id, then requires every `/v1/chat` and `/settle` request to be signed by that key | `gateway/src/auth.js`, `test/auth.test.js`. Smoke test: unsigned → 401, forged → 401 |
| Requests cannot be replayed or altered | The signature covers method, path, session id, a timestamp (±2 min) and the sha256 of the exact body. Each signature is accepted once | `test/auth.test.js`. Smoke test: replay → 401 |
| A user cannot chat and then avoid paying | Three ways were open and are closed. (1) Walking away: a session with metered usage that expires is settled by the gateway itself inside the 15-minute settlement window, so it cannot be reclaimed in full. (2) Overlapping requests: only one request per session is served at a time, so two cannot both be charged against the same running total. (3) Settling during a reply: a settle is refused while a reply is streaming, and no reply can start while a settle is in flight | `sweep`, `busy` in `server.js`. Smoke test: overlapping requests give one 200 and one 409; an abandoned 60-second session is settled with its metered cost |
| TEE mode only: the attestation gate cannot be skipped | Every prompt, however the session is paid, waits for a verified attestation when a real model is configured. The request cannot opt out | `chatLocked` in `server.js` |
| The browser cannot choose what it is charged | Cost is metered on the gateway per token and capped at the on-chain cap. With a real model, the provider's own token count is used | `handleChat` in `server.js` |
| TEE mode only: the prompt is only sent to a verified enclave | Before forwarding, the gateway fetches a NEAR AI Cloud attestation with a fresh nonce and checks: nonce echoed, signing address + nonce bound in the TDX quote's `report_data`, MRTD equals the published `tcb_info`, MRCONFIGID equals `01 ‖ sha256(app_compose)`, Intel DCAP verification of the quote, NVIDIA NRAS verification of the GPU evidence. If any check fails with a real model configured, the prompt is not sent and nothing is charged | `gateway/src/nearai.js`, `test/nearai.test.js`. All six checks pass against the live service |
| TEE mode only: the answer came from that enclave | After each real reply the gateway fetches the provider's ECDSA signature for the completion and checks it recovers to the attested signing address and covers sha256 of the exact request and response bytes | `verifySignature` in `nearai.js`, unit-tested, and passing against the live service in the smoke test (all nine checks) |
| No chat content at rest on the gateway | Only token counts, cost and public chat keys are written (`gateway/.data/`). The transcript lives in the browser's localStorage | `server.js` |
| Private payment: a session is backed by a paid note, and the gateway cannot tell which | Semaphore v4 Groth16 membership proof over the public list of note commitments, with a fixed scope (one nullifier per note) and a message that commits to the session's signing key. The gateway checks scope, Merkle root, key binding, the proof itself, and that the nullifier is new. No account id is in the request | `gateway/src/notes.js`, `test/notes.test.js` (real proofs: double spend, stolen proof, unpaid identity, wrong scope and tampered proof are all rejected). Smoke test on testnet |
| Private payment: a note is paid for before it is listed | The purchase is an on-chain session for exactly the note price whose `open_session` transaction carries the commitment. The gateway checks owner, price and transaction, settles the full cap, then lists the commitment. Repeating the request neither charges nor lists twice | `register` in `notes.js`, unit-tested |
| Secrets stay out of the repo and the browser | `gateway/.env` is git-ignored. The gateway key is a function-call key limited to `settle_session`. The NEAR AI Cloud key never reaches the browser | `.gitignore`, `gateway/.env.example` |

### Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| G-16 | High | **Prompts are not confidential in the hosted setup.** Replies come from free OpenRouter models: OpenRouter and the model's host read every prompt and may log or train on it. There is no TEE and nothing to attest. | Disclosed on every answer ("Not in a TEE" card), in the session dialog, the chat header and the README. The TEE mode (`MODEL_PROVIDER=nearai`) remains available. `OPENROUTER_DATA_COLLECTION=deny` narrows routing to providers that say they do not store prompts, on OpenRouter's best knowledge |
| G-17 | Low | **Free-model capacity is shared.** 20 requests a minute and 1000 a day for the whole account, across all users. One user can use up the minute. | The gateway enforces slightly lower caps itself and refuses before calling upstream, so nothing is charged. A per-user limit would need the gateway to know users, which private payment avoids |
| G-1 | Medium | **The gateway operator sees prompts in plaintext** (and so does anyone who compromises the gateway host). The TEE protects the prompt from the model provider, not from us. | Disclosed in the app and README. Fix: end-to-end encrypt to the enclave's attested `signing_public_key` in the browser |
| G-2 | Medium | **Attestation is verified by the gateway, not by the browser.** A user must trust the gateway's "Verified" badge, or re-check the raw quote shown in the panel themselves. Two checks rely on third-party services (a DCAP verifier hosted by Phala, NVIDIA NRAS). The RTMR3 event-log replay from NEAR's verification guide is not done. | Accepted. The raw quote, nonce and signing address are shown so anyone can re-verify. Fix: verify DCAP in the browser (wasm `dcap-qvl`) |
| G-3 | Medium | **Private-payment anonymity is only as large as the note pool.** Note purchases are public, so the payer of a private session is one of the note buyers. With few notes, or one buyer, that hides little. Buying and spending back to back can be matched by timing. The gateway also sees the IP address. | Disclosed where it matters: the session dialog warns before a buy-and-spend, and the proof panel shows the pool size and warns when it is under 10. Fix: more users, a delay between buy and spend, Tor or a relay for the network layer |
| G-10 | Medium | **Note proofs are verified by the gateway, not on-chain, and the gateway keeps the note list and the spent-nullifier set.** A dishonest or compromised gateway could refuse a paid note, or lose the list. It cannot learn which note is being spent, and it cannot spend a user's note (that needs the secret). | Accepted, same trust as M-1 (the gateway is already trusted for charging). The list is auditable: every commitment in `GET /v1/notes` comes from a public `open_session` transaction. Fix: a note-pool contract that verifies the Groth16 proof with NEAR's alt_bn128 host functions |
| G-11 | Low | **Unused note value is not refunded,** and the note price is fixed (0.02 NEAR). A refund would have to be anonymous too. | Stated in the session dialog |
| G-12 | Low | **Note secrets live in localStorage.** Clearing site data loses unspent notes; XSS could steal them. Loss is bounded by the note price. | Accepted |
| G-13 | Info | The browser downloads the Semaphore circuit files from a public CDN the first time it proves, which shows that CDN the user's IP address (not the account or the note). | Accepted. Fix: serve the files from the app's own origin |
| G-4 | Low | **The chat key lives in localStorage.** XSS in the app could sign requests for open sessions. Damage is bounded by each session's cap and expiry; it cannot withdraw or open sessions. | Accepted. The key is deleted when the session closes |
| G-5 | Low | **`GET /v1/metering` and `/v1/attestation` are unauthenticated.** Metering reveals the metered spend of a session id to anyone who can reach the gateway (the same data becomes public at settlement). No rate limiting anywhere. | Accepted for the prototype. Put the gateway behind a rate-limiting proxy before production |
| G-6 | Low | **Metering state is a local JSON file.** If it is lost before settlement, the session settles at 0 (the user is undercharged, never overcharged). | Accepted |
| G-7 | Info | Sessions opened without a chat key (from the CLI, or by an older build) cannot be used through the gateway; they can be reclaimed after the deadline, or settled by the operator with `npm run settle`. | By design |
| G-8 | Info | Intents funding shows real 1Click dry-run prices but does not execute swaps. | Stated on the Funding page |
| G-14 | Low | **The mainnet contract is not deployed** (`nexora-credits.near` does not exist) and the gateway serves one network. On mainnet the app explains this instead of failing obscurely. | Deploy and run a mainnet gateway before any mainnet use |
| G-15 | Low | **Some wallets do not return the transaction hash or result of `open_session`.** The session id is then found on-chain, but without the hash the gateway cannot check the chat key, so that session cannot be used and must be reclaimed. Not tested with every wallet. | The app says so. Fix: look the transaction up through an indexer |
| G-9 | Info | **Chat can start a NEAR transfer** (private sessions only). Mitigations: questions and negated requests ("don't send…") are not treated as transfers, and the dialog offers "Ask the model instead"; the request is parsed by a strict, unit-tested parser in the browser, never by a model, so neither a model reply nor the gateway can trigger or alter a transfer; only text the user typed and submitted is parsed; amounts use integer math; the recipient is checked on-chain; a confirmation shows amount, recipient and network; the wallet asks again. The transfer is public and is not a zkAPI payment. | By design. `gateway/test/transferIntent.test.js` |

## Reproduce

```bash
cd contract
cargo fmt --check
cargo clippy --all-features --lib --tests -- -W clippy::all -W clippy::nursery
cargo test --lib                      # unit + property tests (any OS)
cargo test --test integration         # sandbox tests (Linux/macOS)
cargo audit
cargo near build non-reproducible-wasm   # add --no-abi on Windows
```
