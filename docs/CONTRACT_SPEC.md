# Nexora credits contract: specification

Rust, `near-sdk` 5.30. Source: [`contract/src/lib.rs`](../contract/src/lib.rs).
See [WORKFLOW.md](WORKFLOW.md) for the user-facing flow.

## State

```
Contract {
  owner_id: AccountId
  gateway_id: AccountId
  paused: bool
  accounts: LookupMap<AccountId, Account>      // prefix b"a"
  sessions: LookupMap<u64, Session>            // prefix b"s"  (open sessions only)
  next_session_id: u64
  fees_accrued: NearToken                      // settled spend, owed to the operator
}

Account {
  available: NearToken        // unlocked, withdrawable
  locked: NearToken           // sum of caps of this account's open sessions
  storage_reserve: NearToken  // 0.05 NEAR taken from the first deposit
  open_sessions: Vec<u64>     // ≤ 4
  receipts: Vec<Receipt>      // ring buffer, newest last, ≤ 20
  pending_withdrawals: u32    // withdrawals whose transfer has not resolved yet
}

Session  { owner, cap, opened_at, expires_at }
Receipt  { session_id, cap, spent, refunded, receipt_hash: Option<String>, closed_at, outcome: Settled | Reclaimed }
```

**Invariant:** for every account, `locked == Σ cap` over its open sessions. The contract's
NEAR balance is always at least `Σ (available + locked + storage_reserve) + fees_accrued`,
plus whatever covers its own code and state.

## Functions

| Function | Caller | Deposit | Effect |
|---|---|---|---|
| `new(owner_id, gateway_id)` | deployer | – | `#[init]`, callable once |
| `deposit()` | anyone | ≥ 0.001 NEAR; first deposit > 0.05 NEAR | Registers the account on the first deposit (keeping the storage reserve) and adds the rest to `available`. Blocked while paused |
| `open_session(cap, ttl_seconds) → U64` | account holder (session key) | none | `cap ≥ 0.001 NEAR`, `60 ≤ ttl ≤ 86400`, `open_sessions < 4`, `available ≥ cap`. Moves `cap` to `locked`. Blocked while paused |
| `settle_session(session_id, spent, receipt_hash)` | **gateway only** | none | `spent ≤ cap`, `receipt_hash` is 64 lowercase hex characters, `now ≤ expires_at + grace`. Deletes the session, refunds `cap − spent`, adds `spent` to `fees_accrued`, stores a receipt. Each session settles at most once |
| `reclaim_session(session_id)` | **session owner only** | none | Only when `now > expires_at + grace`. Deletes the session and returns the full cap to `available` |
| `withdraw(amount) → Promise` | account holder | exactly 1 yocto | `amount ≤ available`. Debits first, then transfers. The callback re-credits if the transfer fails |
| `unregister() → Promise` | account holder | exactly 1 yocto | Only with no open sessions, nothing locked or available, and no pending withdrawals. Deletes the account and returns the storage reserve. The callback restores the account if the transfer fails |
| `set_gateway(gateway_id)` | owner | 1 yocto | Rotates the gateway |
| `set_paused(paused)` | owner | 1 yocto | Pause blocks `deposit` and `open_session` only, so users can always settle, reclaim and withdraw |
| `set_owner(owner_id)` | owner | 1 yocto | Transfers ownership |
| `withdraw_fees(amount) → Promise` | owner | 1 yocto | Pays `fees_accrued` to the owner. The callback restores it if the transfer fails |
| `on_withdraw`, `on_unregister`, `on_fees_withdrawn` | contract itself (`#[private]`) | – | Callbacks. They never panic |

### Views

| View | Returns |
|---|---|
| `get_config()` | owner, gateway, paused, fees, next session id, limits |
| `get_balance(account_id)` | `available`, `locked`, `storage_reserve`, open session ids, or `null` if unregistered |
| `get_session(session_id)` | `owner`, `cap`, `opened_at`, `expires_at`, `settle_deadline`, or `null` when closed or unknown |
| `get_receipts(account_id)` | The last ≤ 20 receipts, newest last |

JSON uses strings for every 64- and 128-bit number (`U64`, and `NearToken` as a yocto string).

### Events

Logged as `EVENT_JSON:{"standard":"nexora","version":"1.0.0","event":…,"data":[…]}` for
`deposit`, `session_opened`, `session_settled`, `session_reclaimed`, `withdraw` and
`withdraw_failed`.

## Limits

| Constant | Value |
|---|---|
| `STORAGE_RESERVE` | 0.05 NEAR, which covers the worst-case per-account storage of about 3.5 KB with headroom |
| `MIN_AMOUNT` | 0.001 NEAR, for deposits and session caps |
| `MAX_OPEN_SESSIONS` | 4 per account |
| `MAX_RECEIPTS` | 20 per account (ring buffer) |
| `MIN_TTL` / `MAX_TTL` | 60 s / 86 400 s |
| `SETTLE_GRACE` | 15 min |
| `CALLBACK_GAS` | 10 TGas |

## Security properties

1. **Access control:** settle is gateway-only, reclaim is owner-only, and admin functions
   are owner-only with 1 yocto. Callbacks are `#[private]`.
2. **State machine:** a session exists only while open, and settle or reclaim deletes it,
   so double settle and settle-plus-reclaim are impossible. Their windows do not overlap.
3. **Funds before promises:** every transfer is debited first. Its callback restores the
   balance on failure and never panics.
4. **1 yocto** on `withdraw`, `unregister` and all admin calls, so a function-call key
   (including a leaked session key) cannot drain funds.
5. **Checked math:** `NearToken::checked_*` with explicit errors, plus
   `overflow-checks = true` in release.
6. **Bounded storage:** at most 4 sessions and 20 receipts per account, paid for by the
   storage reserve. No unbounded loops.
7. **A compromised gateway key** can take at most the caps of currently open sessions, and
   only until each one's settle deadline. It cannot touch `available` or withdraw anything.
8. **Pause** cannot trap funds.

## Out of scope / known limits

- The gateway is trusted to report `spent` honestly, up to the cap. A user's protection is
  the cap they choose.
- There is no on-chain verification of the TEE attestation. Only the receipt hash is stored.
- There is no upgrade or migrate method yet. Redeploying means a new account, or adding
  a `migrate` method later.
