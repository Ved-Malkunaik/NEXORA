# Nexora workflow

How a user goes from sign-in to a settled, private chat session. The contract is a
**prepaid credit ledger with capped sessions**: the user locks a cap, the gateway settles
the real cost, and the user can always reclaim unspent credits.

## Actors

| Actor | What it is | Key it uses |
|---|---|---|
| User | A NEAR account holder, using the web app | Wallet (full access) for deposits and withdrawals. A function-call **session key** for `open_session` and `reclaim_session` |
| Gateway | Our Node service that proxies chat to NEAR AI Cloud and settles cost | A function-call key limited to `settle_session` on the contract |
| Owner | The deployer / operator | Full-access key. Only used for `set_gateway`, `set_paused`, `withdraw_fees`, `set_owner` |
| NEAR AI Cloud | TEE-hosted model provider | API key held by the gateway |

## Happy path

1. **Connect.** The user signs in with a wallet. The wallet selector adds a function-call
   access key limited to `open_session` and `reclaim_session` on the credits contract.
2. **Deposit.** The user calls `deposit()` with attached NEAR, signed in the wallet
   (function-call keys cannot attach deposits). The first deposit sets aside a
   0.05 NEAR storage reserve, refundable through `unregister()`.
3. **Open a session.** The app calls `open_session(cap, ttl_seconds)` with the session key,
   so there is no wallet popup. `cap` moves from `available` to `locked`, and the call
   returns a session id.
4. **Chat.** The browser sends prompts to the gateway along with the session id. The gateway
   checks the session on-chain (`get_session`) and forwards to NEAR AI Cloud. The UI
   shows the TEE attestation. The gateway meters cost and stops at the cap.
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

## Timing

| Value | Default | Why |
|---|---|---|
| `ttl_seconds` | 60 s – 24 h, chosen by the app | How long the gateway may serve the session |
| Settlement grace | 15 min after `expires_at` | Lets the gateway settle a chat that ended right at expiry |
| Reclaim opens | `expires_at + 15 min` | The same instant the settlement window closes, so the two never overlap |

## Decision: who sees the prompt?

Every prompt passes through our gateway, so **the gateway operator sees plaintext**, even
though the model runs in a TEE.

- **(a) Gateway proxy, disclosed as a trusted operator.** This is the default we are
  building. The README states it plainly.
- **(b) The browser talks to NEAR AI Cloud directly.** Only possible if NEAR AI Cloud
  issues scoped or limited keys; that check is still open.

Recommendation: (a) unless (b) turns out to be easy. **Status: pending your confirmation.**

## Privacy tradeoffs (for the README)

- On-chain session history ties an account to its usage volume (cap, spent, timing).
  We store only a receipt hash, never prompt or answer content.
- Deposits and withdrawals are public on-chain.
- Mode B hides the prompt from the model provider but not from the gateway, under option (a).
- Mode A (zkAPI) hides who pays from the provider, but not the user's IP address or the
  prompt contents. Its key-reuse window must be set to 0.
