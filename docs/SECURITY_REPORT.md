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
