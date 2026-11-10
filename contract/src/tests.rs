use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use proptest::prelude::*;

const OWNER: &str = "owner.testnet";
const GATEWAY: &str = "gateway.testnet";
const ALICE: &str = "alice.testnet";
const BOB: &str = "bob.testnet";
const CONTRACT: &str = "credits.testnet";
const T0: u64 = 1_700_000_000 * NS_PER_SECOND;
const HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}
fn milli(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}
fn aid(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn zero() -> NearToken {
    NearToken::from_yoctonear(0)
}

fn ctx(predecessor: &str, deposit: NearToken, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .attached_deposit(deposit)
        .block_timestamp(ts);
    testing_env!(b.build());
}

/// Fresh contract on a fresh mocked chain. `testing_env!` keeps storage between calls,
/// so start from an empty one here (matters for proptest, which reuses the thread).
fn setup() -> Contract {
    let mut b = VMContextBuilder::new();
    b.current_account_id(aid(CONTRACT))
        .predecessor_account_id(aid(OWNER))
        .signer_account_id(aid(OWNER))
        .block_timestamp(T0);
    env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        Default::default(),
        Default::default(),
        None,
    ));
    Contract::new(OWNER.parse().unwrap(), GATEWAY.parse().unwrap())
}

/// Registered account with `amount` deposited (so available = amount - reserve).
fn funded(c: &mut Contract, who: &str, amount: NearToken) {
    ctx(who, amount, T0);
    c.deposit();
}

fn bal(c: &Contract, who: &str) -> BalanceView {
    c.get_balance(who.parse().unwrap()).expect("registered")
}

fn open(c: &mut Contract, who: &str, cap: NearToken, ttl: u64) -> U64 {
    ctx(who, zero(), T0);
    c.open_session(cap, U64(ttl))
}

fn deadline(ttl: u64) -> u64 {
    T0 + ttl * NS_PER_SECOND + SETTLE_GRACE_NS
}

// ---------- init / config ----------

#[test]
fn init_sets_config() {
    let c = setup();
    let cfg = c.get_config();
    assert_eq!(cfg.owner_id.as_str(), OWNER);
    assert_eq!(cfg.gateway_id.as_str(), GATEWAY);
    assert!(!cfg.paused);
    assert_eq!(cfg.fees_accrued, zero());
    assert_eq!(cfg.next_session_id, U64(1));
}

// ---------- deposit ----------

#[test]
fn first_deposit_registers_and_keeps_reserve() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let b = bal(&c, ALICE);
    assert_eq!(b.available, sub(near(1), STORAGE_RESERVE, ""));
    assert_eq!(b.storage_reserve, STORAGE_RESERVE);
    assert_eq!(b.locked, zero());
}

#[test]
fn second_deposit_adds_everything() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    funded(&mut c, ALICE, near(2));
    assert_eq!(bal(&c, ALICE).available, sub(near(3), STORAGE_RESERVE, ""));
}

#[test]
#[should_panic(expected = "First deposit must exceed the 0.05 NEAR storage reserve")]
fn first_deposit_must_exceed_reserve() {
    let mut c = setup();
    funded(&mut c, ALICE, STORAGE_RESERVE);
}

#[test]
#[should_panic(expected = "Deposit at least 0.001 NEAR")]
fn tiny_deposit_rejected() {
    let mut c = setup();
    funded(&mut c, ALICE, NearToken::from_yoctonear(5));
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn deposit_blocked_when_paused() {
    let mut c = setup();
    ctx(OWNER, ONE_YOCTO, T0);
    c.set_paused(true);
    funded(&mut c, ALICE, near(1));
}

// ---------- open_session ----------

#[test]
fn open_session_locks_cap() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(200), 600);
    assert_eq!(id, U64(1));
    let b = bal(&c, ALICE);
    assert_eq!(b.locked, milli(200));
    assert_eq!(b.available, milli(750));
    assert_eq!(b.open_sessions, vec![U64(1)]);
    let s = c.get_session(id).unwrap();
    assert_eq!(s.owner.as_str(), ALICE);
    assert_eq!(s.expires_at, U64(T0 + 600 * NS_PER_SECOND));
    assert_eq!(s.settle_deadline, U64(deadline(600)));
}

#[test]
#[should_panic(expected = "Not enough available credits")]
fn open_session_over_balance() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    open(&mut c, ALICE, near(1), 600);
}

#[test]
#[should_panic(expected = "Account not registered")]
fn open_session_unregistered() {
    let mut c = setup();
    open(&mut c, ALICE, milli(10), 600);
}

#[test]
#[should_panic(expected = "ttl_seconds must be between 60 and 86400")]
fn open_session_ttl_too_short() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    open(&mut c, ALICE, milli(10), 59);
}

#[test]
#[should_panic(expected = "ttl_seconds must be between 60 and 86400")]
fn open_session_ttl_too_long() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    open(&mut c, ALICE, milli(10), MAX_TTL_SECONDS + 1);
}

#[test]
#[should_panic(expected = "Cap must be at least 0.001 NEAR")]
fn open_session_cap_too_small() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    open(&mut c, ALICE, NearToken::from_yoctonear(1), 600);
}

#[test]
#[should_panic(expected = "Too many open sessions")]
fn open_session_limit() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    for _ in 0..=MAX_OPEN_SESSIONS {
        open(&mut c, ALICE, milli(10), 600);
    }
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn open_session_blocked_when_paused() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(OWNER, ONE_YOCTO, T0);
    c.set_paused(true);
    open(&mut c, ALICE, milli(10), 600);
}

// ---------- settle ----------

#[test]
fn settle_charges_spent_and_refunds_rest() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(200), 600);
    ctx(GATEWAY, zero(), T0 + 100 * NS_PER_SECOND);
    c.settle_session(id, milli(30), HASH.into());

    let b = bal(&c, ALICE);
    assert_eq!(b.locked, zero());
    assert_eq!(b.available, milli(920)); // 950 - 30
    assert!(b.open_sessions.is_empty());
    assert_eq!(c.get_config().fees_accrued, milli(30));
    assert!(c.get_session(id).is_none());
    let r = c.get_receipts(ALICE.parse().unwrap());
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].outcome, Outcome::Settled);
    assert_eq!(r[0].spent, milli(30));
    assert_eq!(r[0].refunded, milli(170));
    assert_eq!(r[0].receipt_hash.as_deref(), Some(HASH));
}

#[test]
fn settle_full_cap_and_zero_spend() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let a = open(&mut c, ALICE, milli(100), 600);
    let b = open(&mut c, ALICE, milli(100), 600);
    ctx(GATEWAY, zero(), T0);
    c.settle_session(a, milli(100), HASH.into());
    c.settle_session(b, zero(), HASH.into());
    assert_eq!(bal(&c, ALICE).available, milli(850));
    assert_eq!(c.get_config().fees_accrued, milli(100));
}

#[test]
fn settle_allowed_exactly_at_deadline() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(GATEWAY, zero(), deadline(600));
    c.settle_session(id, milli(1), HASH.into());
}

#[test]
#[should_panic(expected = "Only the gateway can settle")]
fn settle_unauthorized() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(ALICE, zero(), T0);
    c.settle_session(id, zero(), HASH.into());
}

#[test]
#[should_panic(expected = "Only the gateway can settle")]
fn owner_cannot_settle() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(OWNER, zero(), T0);
    c.settle_session(id, zero(), HASH.into());
}

#[test]
#[should_panic(expected = "Session not found or already closed")]
fn double_settle() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(GATEWAY, zero(), T0);
    c.settle_session(id, milli(1), HASH.into());
    c.settle_session(id, milli(1), HASH.into());
}

#[test]
#[should_panic(expected = "Spent exceeds session cap")]
fn settle_cap_exceeded() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(GATEWAY, zero(), T0);
    c.settle_session(
        id,
        NearToken::from_yoctonear(milli(100).as_yoctonear() + 1),
        HASH.into(),
    );
}

#[test]
#[should_panic(expected = "Settlement window has closed")]
fn settle_after_deadline() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(GATEWAY, zero(), deadline(600) + 1);
    c.settle_session(id, milli(1), HASH.into());
}

#[test]
#[should_panic(expected = "receipt_hash must be 64 lowercase hex characters")]
fn settle_bad_hash() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(GATEWAY, zero(), T0);
    c.settle_session(id, milli(1), "not-a-hash".into());
}

#[test]
#[should_panic(expected = "receipt_hash must be 64 lowercase hex characters")]
fn settle_uppercase_hash_rejected() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(GATEWAY, zero(), T0);
    c.settle_session(id, milli(1), HASH.to_uppercase());
}

#[test]
#[should_panic(expected = "Session not found or already closed")]
fn settle_unknown_session() {
    let mut c = setup();
    ctx(GATEWAY, zero(), T0);
    c.settle_session(U64(42), zero(), HASH.into());
}

// ---------- reclaim ----------

#[test]
fn reclaim_after_deadline_returns_full_cap() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(200), 600);
    ctx(ALICE, zero(), deadline(600) + 1);
    c.reclaim_session(id);
    let b = bal(&c, ALICE);
    assert_eq!(b.available, milli(950));
    assert_eq!(b.locked, zero());
    assert_eq!(c.get_config().fees_accrued, zero());
    let r = c.get_receipts(ALICE.parse().unwrap());
    assert_eq!(r[0].outcome, Outcome::Reclaimed);
    assert_eq!(r[0].receipt_hash, None);
}

#[test]
#[should_panic(expected = "Session cannot be reclaimed until its settle deadline passes")]
fn reclaim_before_deadline() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(200), 600);
    ctx(ALICE, zero(), deadline(600));
    c.reclaim_session(id);
}

#[test]
#[should_panic(expected = "Only the session owner can reclaim")]
fn reclaim_by_other_user() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    funded(&mut c, BOB, near(1));
    let id = open(&mut c, ALICE, milli(200), 600);
    ctx(BOB, zero(), deadline(600) + 1);
    c.reclaim_session(id);
}

#[test]
#[should_panic(expected = "Session not found or already closed")]
fn reclaim_after_settle() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(200), 600);
    ctx(GATEWAY, zero(), T0);
    c.settle_session(id, milli(1), HASH.into());
    ctx(ALICE, zero(), deadline(600) + 1);
    c.reclaim_session(id);
}

#[test]
#[should_panic(expected = "Session not found or already closed")]
fn settle_after_reclaim() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(200), 600);
    ctx(ALICE, zero(), deadline(600) + 1);
    c.reclaim_session(id);
    ctx(GATEWAY, zero(), deadline(600) + 2);
    c.settle_session(id, milli(1), HASH.into());
}

#[test]
fn settle_and_reclaim_work_while_paused() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let a = open(&mut c, ALICE, milli(100), 600);
    let b = open(&mut c, ALICE, milli(100), 600);
    ctx(OWNER, ONE_YOCTO, T0);
    c.set_paused(true);
    ctx(GATEWAY, zero(), T0);
    c.settle_session(a, milli(10), HASH.into());
    ctx(ALICE, zero(), deadline(600) + 1);
    c.reclaim_session(b);
    assert_eq!(bal(&c, ALICE).available, milli(940));
}

// ---------- withdraw ----------

#[test]
fn withdraw_debits_before_transfer() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.withdraw(milli(500));
    assert_eq!(bal(&c, ALICE).available, milli(450));
    let acc = c.accounts.get(&aid(ALICE)).unwrap();
    assert_eq!(acc.pending_withdrawals, 1);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_without_yocto() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, zero(), T0);
    let _ = c.withdraw(milli(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_with_two_yocto() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, NearToken::from_yoctonear(2), T0);
    let _ = c.withdraw(milli(1));
}

#[test]
#[should_panic(expected = "Not enough available credits")]
fn withdraw_cannot_touch_locked() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    open(&mut c, ALICE, milli(900), 600);
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.withdraw(milli(100));
}

#[test]
#[should_panic(expected = "Not enough available credits")]
fn withdraw_cannot_touch_reserve() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.withdraw(near(1));
}

#[test]
fn failed_withdraw_is_recredited() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.withdraw(milli(500));
    ctx(CONTRACT, zero(), T0);
    assert!(!c.on_withdraw(
        ALICE.parse().unwrap(),
        milli(500),
        Err(PromiseError::Failed)
    ));
    assert_eq!(bal(&c, ALICE).available, milli(950));
    assert_eq!(c.accounts.get(&aid(ALICE)).unwrap().pending_withdrawals, 0);
}

#[test]
fn successful_withdraw_clears_pending() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.withdraw(milli(500));
    ctx(CONTRACT, zero(), T0);
    assert!(c.on_withdraw(ALICE.parse().unwrap(), milli(500), Ok(())));
    assert_eq!(bal(&c, ALICE).available, milli(450));
    assert_eq!(c.accounts.get(&aid(ALICE)).unwrap().pending_withdrawals, 0);
}

// #[private] is enforced in the wasm entry point, so it is covered by tests/integration.rs.

// ---------- unregister ----------

#[test]
fn unregister_empty_account() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.withdraw(milli(950));
    ctx(CONTRACT, zero(), T0);
    c.on_withdraw(ALICE.parse().unwrap(), milli(950), Ok(()));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.unregister();
    assert!(c.get_balance(ALICE.parse().unwrap()).is_none());
}

#[test]
fn failed_unregister_restores_account() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.withdraw(milli(950));
    ctx(CONTRACT, zero(), T0);
    c.on_withdraw(ALICE.parse().unwrap(), milli(950), Ok(()));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.unregister();
    ctx(CONTRACT, zero(), T0);
    assert!(!c.on_unregister(
        ALICE.parse().unwrap(),
        STORAGE_RESERVE,
        Err(PromiseError::Failed)
    ));
    assert_eq!(bal(&c, ALICE).storage_reserve, STORAGE_RESERVE);
}

#[test]
#[should_panic(expected = "A withdrawal is still pending")]
fn unregister_blocked_by_pending_withdrawal() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.withdraw(milli(950));
    let _ = c.unregister();
}

#[test]
#[should_panic(expected = "Close open sessions first")]
fn unregister_blocked_by_open_session() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    open(&mut c, ALICE, milli(950), 600);
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.unregister();
}

#[test]
#[should_panic(expected = "Withdraw available credits first")]
fn unregister_blocked_by_balance() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    ctx(ALICE, ONE_YOCTO, T0);
    let _ = c.unregister();
}

// ---------- owner ----------

#[test]
fn owner_can_rotate_gateway() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(OWNER, ONE_YOCTO, T0);
    c.set_gateway(BOB.parse().unwrap());
    ctx(BOB, zero(), T0);
    c.settle_session(id, milli(1), HASH.into());
}

#[test]
#[should_panic(expected = "Only the owner can call this")]
fn non_owner_cannot_set_gateway() {
    let mut c = setup();
    ctx(ALICE, ONE_YOCTO, T0);
    c.set_gateway(ALICE.parse().unwrap());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_needs_yocto() {
    let mut c = setup();
    ctx(OWNER, zero(), T0);
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "Only the owner can call this")]
fn gateway_cannot_pause() {
    let mut c = setup();
    ctx(GATEWAY, ONE_YOCTO, T0);
    c.set_paused(true);
}

#[test]
fn set_owner_transfers_control() {
    let mut c = setup();
    ctx(OWNER, ONE_YOCTO, T0);
    c.set_owner(BOB.parse().unwrap());
    ctx(BOB, ONE_YOCTO, T0);
    c.set_paused(true);
    assert!(c.get_config().paused);
}

#[test]
fn withdraw_fees_and_restore_on_failure() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    let id = open(&mut c, ALICE, milli(100), 600);
    ctx(GATEWAY, zero(), T0);
    c.settle_session(id, milli(40), HASH.into());

    ctx(OWNER, ONE_YOCTO, T0);
    let _ = c.withdraw_fees(milli(40));
    assert_eq!(c.get_config().fees_accrued, zero());
    ctx(CONTRACT, zero(), T0);
    assert!(!c.on_fees_withdrawn(milli(40), Err(PromiseError::Failed)));
    assert_eq!(c.get_config().fees_accrued, milli(40));
}

#[test]
#[should_panic(expected = "Not enough accrued fees")]
fn withdraw_fees_over_accrued() {
    let mut c = setup();
    ctx(OWNER, ONE_YOCTO, T0);
    let _ = c.withdraw_fees(milli(1));
}

// ---------- bounds ----------

#[test]
fn receipts_are_a_bounded_ring() {
    let mut c = setup();
    funded(&mut c, ALICE, near(1));
    for _ in 0..(MAX_RECEIPTS + 5) {
        let id = open(&mut c, ALICE, milli(1), 600);
        ctx(GATEWAY, zero(), T0);
        c.settle_session(id, zero(), HASH.into());
    }
    let r = c.get_receipts(ALICE.parse().unwrap());
    assert_eq!(r.len(), MAX_RECEIPTS);
    assert_eq!(r.last().unwrap().session_id, U64((MAX_RECEIPTS + 5) as u64));
    assert_eq!(r.first().unwrap().session_id, U64(6));
}

/// Worst case per account (64-char id, 4 open sessions, 20 receipts with hashes) must fit in the reserve.
#[test]
fn storage_reserve_covers_worst_case_account() {
    let mut c = setup();
    let long_id = format!("{}.testnet", "a".repeat(56));
    c.accounts.flush();
    c.sessions.flush();
    let before = env::storage_usage();

    funded(&mut c, &long_id, near(5));
    for _ in 0..MAX_RECEIPTS {
        let id = open(&mut c, &long_id, milli(1), 600);
        ctx(GATEWAY, zero(), T0);
        c.settle_session(id, zero(), HASH.into());
    }
    for _ in 0..MAX_OPEN_SESSIONS {
        open(&mut c, &long_id, milli(1), 600);
    }
    c.accounts.flush();
    c.sessions.flush();
    let used = env::storage_usage() - before;
    let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
    assert!(
        cost < STORAGE_RESERVE,
        "worst-case account uses {used} bytes = {cost}, reserve is {STORAGE_RESERVE}"
    );
}

// ---------- property tests ----------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Settling never creates or destroys credits: available + locked + fees is conserved.
    #[test]
    fn settle_conserves_credits(cap_milli in 1u128..900, spent_frac in 0u128..=1000) {
        let mut c = setup();
        funded(&mut c, ALICE, near(1));
        let cap = milli(cap_milli);
        let spent = NearToken::from_yoctonear(cap.as_yoctonear() * spent_frac / 1000);
        let id = open(&mut c, ALICE, cap, 600);
        ctx(GATEWAY, zero(), T0);
        c.settle_session(id, spent, HASH.into());
        let b = bal(&c, ALICE);
        let total = b.available.as_yoctonear() + b.locked.as_yoctonear()
            + c.get_config().fees_accrued.as_yoctonear();
        prop_assert_eq!(total, milli(950).as_yoctonear());
        prop_assert_eq!(c.get_config().fees_accrued, spent);
    }

    /// Random interleavings of open / settle / reclaim keep `locked == Σ open caps`
    /// and conserve the ledger.
    #[test]
    fn ledger_invariant_holds(ops in prop::collection::vec((0u8..3, 1u128..200, 0u128..=1000), 1..40)) {
        let mut c = setup();
        funded(&mut c, ALICE, near(2));
        let start = milli(1950).as_yoctonear();
        let mut open_ids: Vec<(U64, NearToken)> = Vec::new();
        for (op, amt, frac) in ops {
            match op {
                0 => {
                    let cap = milli(amt);
                    if open_ids.len() < MAX_OPEN_SESSIONS && bal(&c, ALICE).available >= cap {
                        let id = open(&mut c, ALICE, cap, 600);
                        open_ids.push((id, cap));
                    }
                }
                1 => if let Some((id, cap)) = open_ids.pop() {
                    ctx(GATEWAY, zero(), T0);
                    let spent = NearToken::from_yoctonear(cap.as_yoctonear() * frac / 1000);
                    c.settle_session(id, spent, HASH.into());
                },
                _ => if let Some((id, _)) = open_ids.pop() {
                    ctx(ALICE, zero(), deadline(600) + 1);
                    c.reclaim_session(id);
                },
            }
            let b = bal(&c, ALICE);
            let locked: u128 = open_ids.iter().map(|(_, cap)| cap.as_yoctonear()).sum();
            prop_assert_eq!(b.locked.as_yoctonear(), locked);
            prop_assert_eq!(b.open_sessions.len(), open_ids.len());
            let total = b.available.as_yoctonear() + b.locked.as_yoctonear()
                + c.get_config().fees_accrued.as_yoctonear();
            prop_assert_eq!(total, start);
        }
    }
}
