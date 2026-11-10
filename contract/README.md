# nexora-credits

A prepaid credit ledger with capped chat sessions, written in Rust with `near-sdk` 5.30.

- Spec: [docs/CONTRACT_SPEC.md](../docs/CONTRACT_SPEC.md)
- Flow: [docs/WORKFLOW.md](../docs/WORKFLOW.md)
- Security: [docs/SECURITY_REPORT.md](../docs/SECURITY_REPORT.md)

## Prerequisites

Rust (the toolchain is pinned in `rust-toolchain.toml`), [`cargo-near`](https://github.com/near/cargo-near)
and [`near-cli-rs`](https://github.com/near/near-cli-rs):

```bash
npm install -g cargo-near near-cli-rs
```

On Windows, run that from PowerShell. Git Bash's `tar` breaks the npm installers.

## Build

```bash
cargo near build non-reproducible-wasm          # Linux/macOS
cargo near build non-reproducible-wasm --no-abi # Windows: ABI extraction needs a Unix linker
```

The output is `target/near/nexora_credits.wasm`.

## Test

```bash
cargo test --lib                 # 54 unit + property tests, any OS
cargo test --test integration    # NEAR sandbox tests, Linux/macOS (and CI)
```

## Deploy to testnet

```bash
# 1. Create accounts (each gets testnet NEAR from the faucet)
near account create-account sponsor-by-faucet-service nexora-credits-<you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
near account create-account sponsor-by-faucet-service nexora-gateway-<you>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create

# 2. Deploy and initialise
near contract deploy nexora-credits-<you>.testnet use-file target/near/nexora_credits.wasm \
  with-init-call new json-args '{"owner_id":"<your-account>.testnet","gateway_id":"nexora-gateway-<you>.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# 3. Smoke test
near contract call-function as-read-only nexora-credits-<you>.testnet get_config json-args '{}' network-config testnet now
```

Then set `VITE_TESTNET_CONTRACT_ID=nexora-credits-<you>.testnet` in the web app's `.env.local`.
Sign-in will add a session key scoped to this contract.

## Interface (summary)

| Method | Who | Deposit |
|---|---|---|
| `deposit()` | user | ≥ 0.001 NEAR (the first one must exceed 0.05 NEAR) |
| `open_session(cap, ttl_seconds) → id` | user, via session key | – |
| `settle_session(session_id, spent, receipt_hash)` | gateway | – |
| `reclaim_session(session_id)` | session owner, after `expires_at + 15 min` | – |
| `withdraw(amount)` / `unregister()` | user | 1 yocto |
| `set_gateway`, `set_paused`, `set_owner`, `withdraw_fees` | owner | 1 yocto |
| `get_config`, `get_balance`, `get_session`, `get_receipts` | view | – |
