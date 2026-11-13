# Nexora workflow

How a user goes from sign-in to a settled, private chat session. The contract is a
**prepaid credit ledger with capped sessions**: the user locks a cap, the gateway settles
the real cost, and the user can always reclaim unspent credits.

## Actors

| Actor | What it is | Key it uses |
|---|---|---|
| User | A NEAR account holder, using the web app | Wallet (full access) for deposits and withdrawals. A function-call **session key** for `open_session` and `reclaim_session` |
| Gateway | Our Node service that proxies chat to the model (OpenRouter, or NEAR AI Cloud in TEE mode) and settles cost | A function-call key limited to `settle_session` on the contract |
| Owner | The deployer / operator | Full-access key. Only used for `set_gateway`, `set_paused`, `withdraw_fees`, `set_owner` |
| OpenRouter | Free open models (not in a TEE) | API key held by the gateway |
| NEAR AI Cloud | TEE-hosted models, optional (`MODEL_PROVIDER=nearai`) | API key held by the gateway |

## Happy path

1. **Connect.** The user signs in with a wallet. The wallet selector adds a function-call
   access key limited to `open_session` and `reclaim_session` on the credits contract.
2. **Deposit.** The user calls `deposit()` with attached NEAR, signed in the wallet
   (function-call keys cannot attach deposits). The first deposit sets aside a
   0.05 NEAR storage reserve, refundable through `unregister()`.
3. **Open a session.** The app calls `open_session(cap, ttl_seconds)` with the session key,
   so there is no wallet popup. `cap` moves from `available` to `locked`, and the call
   returns a session id. The same call carries a `client_key`: the public half of a fresh
   chat key that stays in the browser.
4. **Chat.** The browser signs each request with the chat key and sends it to the gateway.
   The gateway checks the session on-chain (`get_session`), checks the signature against the
   `client_key` in the session's `open_session` transaction, and forwards the prompt to a free
   OpenRouter model. Each answer says which model ran it and that it was not in a TEE. (In TEE
   mode the gateway instead verifies NEAR AI Cloud's attestation first and checks the reply's
   signature, and the UI lists every check.) The gateway meters cost and stops at the cap.
5. **Settle.** When the chat ends, the gateway calls
   `settle_session(id, spent, receipt_hash)` with `spent <= cap`. `spent` goes to the
   operator's fee pool, the rest is refunded to `available`, and a receipt (hash only,
   never content) is stored.
6. **Fallback: reclaim.** If the gateway never settles, the user calls
   `reclaim_session(id)` once `expires_at + 15 min` has passed and gets the whole cap back.
7. **Withdraw.** The user calls `withdraw(amount)` with exactly 1 yoctoNEAR attached
   (wallet-signed) to take unlocked credits back to their account.

```
deposit ──► available ──open_session──► locked ──settle──► spent → fee pool
                ▲                          │       └──────► refund → available
                └────────reclaim (after deadline)─┘
available ──withdraw──► user account
```

A session ends exactly one way: it is either settled or reclaimed, never both. A closed
session is deleted from state, so it cannot be settled or reclaimed again.

## Paying privately with a note

Turning on "Pay privately with a note" swaps steps 3 to 5 for two steps that are deliberately separate.

1. **Buy a note (public).** The browser creates a secret and calls
   `open_session(cap = note price, ttl, note_commitment)` with the session key. The gateway
   reads that transaction, settles the session at its full cap, and adds the commitment to
   the public note list. Every note costs the same.
2. **Spend a note (anonymous).** The browser builds a zero-knowledge proof (Semaphore v4,
   Groth16) that it knows the secret of one commitment in the list, bound to a fresh signing
   key, and sends only that proof. The gateway verifies it, records the nullifier so the
   note cannot be spent again, and opens a 24-hour session with the note's token budget.
   Chat requests are signed with that key and carry no account id.

Nothing about a private session goes on-chain. It still runs every prompt through the same verified TEE. There is no refund of unused tokens and no
reclaim: the note was paid in full when it was bought.

## Timing

| Value | Default | Why |
|---|---|---|
| `ttl_seconds` | 60 s – 24 h, chosen by the app | How long the gateway may serve the session |
| Settlement grace | 15 min after `expires_at` | Lets the gateway settle a chat that ended right at expiry |
| Reclaim opens | `expires_at + 15 min` | The same instant the settlement window closes, so the two never overlap |

## Decision: who sees the prompt?

Every prompt passes through our gateway, so **the gateway operator sees plaintext**, even
though the model runs in a TEE.

- **(a) Gateway proxy, disclosed as a trusted operator.** This is what is built. The app
  and README state it plainly.
- **(b) The browser encrypts to the enclave.** NEAR AI Cloud attestations include a
  `signing_public_key` for end-to-end encryption, which would hide prompts from the gateway
  too. Not built yet (security report, G-1).

## Privacy tradeoffs (for the README)

- On-chain session history ties an account to its usage volume (cap, spent, timing).
  We store only a receipt hash, never prompt or answer content.
- Deposits and withdrawals are public on-chain.
- The TEE hides the prompt from the model provider but not from the gateway, under option (a). This applies to every chat.
- Paying with a note hides which account pays for a session, among the accounts that bought notes. It
  does not hide the user's IP address or the prompt contents, and requests inside one
  session are linkable to each other. See "Paying privately with a note" below.
