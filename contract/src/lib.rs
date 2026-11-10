//! Nexora credits contract: a prepaid credit ledger with capped chat sessions.
//!
//! The user locks a cap, the gateway settles the real cost (≤ cap), and the user can
//! always reclaim the full cap if the gateway never settles. Spec: docs/CONTRACT_SPEC.md.

use near_sdk::json_types::U64;
use near_sdk::serde_json::{Value, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, near,
    require,
};

#[cfg(test)]
mod tests;

/// Taken from the first deposit; covers the account's worst-case storage. Refunded by `unregister`.
pub const STORAGE_RESERVE: NearToken = NearToken::from_millinear(50);
/// Smallest deposit and smallest session cap.
pub const MIN_AMOUNT: NearToken = NearToken::from_millinear(1);
pub const MAX_OPEN_SESSIONS: usize = 4;
pub const MAX_RECEIPTS: usize = 20;
pub const MIN_TTL_SECONDS: u64 = 60;
pub const MAX_TTL_SECONDS: u64 = 86_400;
/// How long after `expires_at` the gateway may still settle. Reclaim opens right after.
pub const SETTLE_GRACE_NS: u64 = 15 * 60 * 1_000_000_000;
pub const CALLBACK_GAS: Gas = Gas::from_tgas(10);

const NS_PER_SECOND: u64 = 1_000_000_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
    Sessions,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Settled,
    Reclaimed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub session_id: U64,
    pub cap: NearToken,
    pub spent: NearToken,
    pub refunded: NearToken,
    /// sha256 hex of the off-chain usage record. Never the content itself.
    pub receipt_hash: Option<String>,
    pub closed_at: U64,
    pub outcome: Outcome,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Account {
    pub available: NearToken,
    pub locked: NearToken,
    pub storage_reserve: NearToken,
    pub open_sessions: Vec<u64>,
    pub receipts: Vec<Receipt>,
    pub pending_withdrawals: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Session {
    pub owner: AccountId,
    pub cap: NearToken,
    pub opened_at: u64,
    pub expires_at: u64,
}

impl Session {
    const fn settle_deadline(&self) -> u64 {
        self.expires_at.saturating_add(SETTLE_GRACE_NS)
    }
}

// ---------- JSON views ----------

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct BalanceView {
    pub available: NearToken,
    pub locked: NearToken,
    pub storage_reserve: NearToken,
    pub open_sessions: Vec<U64>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct SessionView {
    pub session_id: U64,
    pub owner: AccountId,
    pub cap: NearToken,
    pub opened_at: U64,
    pub expires_at: U64,
    pub settle_deadline: U64,
}

#[near(serializers = [json])]
#[derive(Debug)]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub gateway_id: AccountId,
    pub paused: bool,
    pub fees_accrued: NearToken,
    pub next_session_id: U64,
    pub storage_reserve: NearToken,
    pub min_amount: NearToken,
    pub max_open_sessions: u32,
    pub max_receipts: u32,
    pub min_ttl_seconds: U64,
    pub max_ttl_seconds: U64,
    pub settle_grace_seconds: U64,
}

// ---------- contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    gateway_id: AccountId,
    paused: bool,
    accounts: LookupMap<AccountId, Account>,
    /// Open sessions only. Settling or reclaiming deletes the entry.
    sessions: LookupMap<u64, Session>,
    next_session_id: u64,
    fees_accrued: NearToken,
}

fn add(a: NearToken, b: NearToken) -> NearToken {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("Amount overflow"))
}

fn sub(a: NearToken, b: NearToken, msg: &str) -> NearToken {
    a.checked_sub(b).unwrap_or_else(|| env::panic_str(msg))
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "nexora", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

// The #[near] macro trips use_self on #[init] and missing_const_for_fn on callbacks (false positives).
#[allow(clippy::use_self, clippy::missing_const_for_fn)]
#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, gateway_id: AccountId) -> Self {
        Self {
            owner_id,
            gateway_id,
            paused: false,
            accounts: LookupMap::new(StorageKey::Accounts),
            sessions: LookupMap::new(StorageKey::Sessions),
            next_session_id: 1,
            fees_accrued: NearToken::from_yoctonear(0),
        }
    }

    // ---------- user: funds ----------

    /// Add credits. The first deposit registers the account and keeps `STORAGE_RESERVE`.
    #[payable]
    pub fn deposit(&mut self) -> NearToken {
        require!(!self.paused, "Contract is paused");
        let account_id = env::predecessor_account_id();
        let amount = env::attached_deposit();
        require!(amount >= MIN_AMOUNT, "Deposit at least 0.001 NEAR");

        let available = match self.accounts.get_mut(&account_id) {
            Some(acc) => {
                acc.available = add(acc.available, amount);
                acc.available
            }
            None => {
                require!(
                    amount > STORAGE_RESERVE,
                    "First deposit must exceed the 0.05 NEAR storage reserve"
                );
                let available = sub(amount, STORAGE_RESERVE, "Deposit below reserve");
                self.accounts.insert(
                    account_id.clone(),
                    Account {
                        available,
                        locked: NearToken::from_yoctonear(0),
                        storage_reserve: STORAGE_RESERVE,
                        open_sessions: Vec::new(),
                        receipts: Vec::new(),
                        pending_withdrawals: 0,
                    },
                );
                available
            }
        };
        emit(
            "deposit",
            json!({ "account_id": account_id, "amount": amount, "available": available }),
        );
        available
    }

    /// Withdraw unlocked credits. Requires exactly 1 yoctoNEAR, so only a full-access key
    /// (the wallet) can call it, never a session key.
    #[payable]
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        require!(
            env::attached_deposit() == ONE_YOCTO,
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        require!(!amount.is_zero(), "Amount must be positive");
        let account_id = env::predecessor_account_id();
        let acc = self
            .accounts
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("Account not registered"));
        // Effects before interaction: debit now, re-credit in the callback if the transfer fails.
        acc.available = sub(acc.available, amount, "Not enough available credits");
        acc.pending_withdrawals = acc
            .pending_withdrawals
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Too many pending withdrawals"));
        emit(
            "withdraw",
            json!({ "account_id": account_id, "amount": amount }),
        );

        Promise::new(account_id.clone()).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_withdraw(account_id, amount),
        )
    }

    /// Close an empty account and get the storage reserve back.
    #[payable]
    pub fn unregister(&mut self) -> Promise {
        require!(
            env::attached_deposit() == ONE_YOCTO,
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        let account_id = env::predecessor_account_id();
        let acc = self
            .accounts
            .get(&account_id)
            .unwrap_or_else(|| env::panic_str("Account not registered"));
        require!(acc.open_sessions.is_empty(), "Close open sessions first");
        require!(acc.locked.is_zero(), "Credits still locked");
        require!(acc.available.is_zero(), "Withdraw available credits first");
        require!(
            acc.pending_withdrawals == 0,
            "A withdrawal is still pending"
        );
        let reserve = acc.storage_reserve;
        self.accounts.remove(&account_id);

        Promise::new(account_id.clone()).transfer(reserve).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_unregister(account_id, reserve),
        )
    }

    // ---------- user: sessions ----------

    /// Lock `cap` credits for a chat session that lasts `ttl_seconds`. Callable with the
    /// function-call session key (no deposit, no wallet popup). Returns the session id.
    pub fn open_session(&mut self, cap: NearToken, ttl_seconds: U64) -> U64 {
        require!(!self.paused, "Contract is paused");
        let ttl = ttl_seconds.0;
        require!(
            (MIN_TTL_SECONDS..=MAX_TTL_SECONDS).contains(&ttl),
            "ttl_seconds must be between 60 and 86400"
        );
        require!(cap >= MIN_AMOUNT, "Cap must be at least 0.001 NEAR");
        let owner = env::predecessor_account_id();
        let session_id = self.next_session_id;
        let acc = self
            .accounts
            .get_mut(&owner)
            .unwrap_or_else(|| env::panic_str("Account not registered"));
        require!(
            acc.open_sessions.len() < MAX_OPEN_SESSIONS,
            "Too many open sessions"
        );
        acc.available = sub(acc.available, cap, "Not enough available credits");
        acc.locked = add(acc.locked, cap);
        acc.open_sessions.push(session_id);

        let now = env::block_timestamp();
        let expires_at = now.saturating_add(ttl.saturating_mul(NS_PER_SECOND));
        self.sessions.insert(
            session_id,
            Session {
                owner: owner.clone(),
                cap,
                opened_at: now,
                expires_at,
            },
        );
        self.next_session_id = session_id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Session id overflow"));

        emit(
            "session_opened",
            json!({ "session_id": U64(session_id), "account_id": owner, "cap": cap, "expires_at": U64(expires_at) }),
        );
        U64(session_id)
    }

    /// Gateway only. Charge `spent` (≤ cap) for a session and refund the rest.
    pub fn settle_session(&mut self, session_id: U64, spent: NearToken, receipt_hash: String) {
        require!(
            env::predecessor_account_id() == self.gateway_id,
            "Only the gateway can settle"
        );
        require!(
            is_sha256_hex(&receipt_hash),
            "receipt_hash must be 64 lowercase hex characters"
        );
        let id = session_id.0;
        let session = self
            .sessions
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Session not found or already closed"));
        require!(
            env::block_timestamp() <= session.settle_deadline(),
            "Settlement window has closed"
        );
        require!(spent <= session.cap, "Spent exceeds session cap");

        let refunded = sub(session.cap, spent, "Spent exceeds session cap");
        self.close_session(
            id,
            &session,
            spent,
            Some(receipt_hash.clone()),
            Outcome::Settled,
        );
        self.fees_accrued = add(self.fees_accrued, spent);

        emit(
            "session_settled",
            json!({
                "session_id": session_id, "account_id": session.owner, "spent": spent,
                "refunded": refunded, "receipt_hash": receipt_hash,
            }),
        );
    }

    /// Session owner only, after the settle deadline. Returns the whole cap.
    pub fn reclaim_session(&mut self, session_id: U64) {
        let id = session_id.0;
        let session = self
            .sessions
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Session not found or already closed"));
        require!(
            env::predecessor_account_id() == session.owner,
            "Only the session owner can reclaim"
        );
        require!(
            env::block_timestamp() > session.settle_deadline(),
            "Session cannot be reclaimed until its settle deadline passes"
        );
        self.close_session(
            id,
            &session,
            NearToken::from_yoctonear(0),
            None,
            Outcome::Reclaimed,
        );
        emit(
            "session_reclaimed",
            json!({ "session_id": session_id, "account_id": session.owner, "refunded": session.cap }),
        );
    }

    // ---------- owner ----------

    #[payable]
    pub fn set_gateway(&mut self, gateway_id: AccountId) {
        self.assert_owner();
        self.gateway_id = gateway_id;
    }

    /// Pause blocks `deposit` and `open_session` only. Settle, reclaim and withdraw keep working.
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    #[payable]
    pub fn set_owner(&mut self, owner_id: AccountId) {
        self.assert_owner();
        self.owner_id = owner_id;
    }

    #[payable]
    pub fn withdraw_fees(&mut self, amount: NearToken) -> Promise {
        self.assert_owner();
        require!(!amount.is_zero(), "Amount must be positive");
        self.fees_accrued = sub(self.fees_accrued, amount, "Not enough accrued fees");
        Promise::new(self.owner_id.clone()).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_fees_withdrawn(amount),
        )
    }

    // ---------- callbacks (never panic) ----------

    #[private]
    pub fn on_withdraw(
        &mut self,
        account_id: AccountId,
        amount: NearToken,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let ok = result.is_ok();
        if let Some(acc) = self.accounts.get_mut(&account_id) {
            acc.pending_withdrawals = acc.pending_withdrawals.saturating_sub(1);
            if !ok {
                acc.available = acc.available.saturating_add(amount);
            }
        } else if !ok {
            // Unreachable while pending_withdrawals blocks unregister; credit the operator pool
            // rather than lose track of the funds.
            self.fees_accrued = self.fees_accrued.saturating_add(amount);
        }
        if !ok {
            emit(
                "withdraw_failed",
                json!({ "account_id": account_id, "amount": amount }),
            );
        }
        ok
    }

    #[private]
    pub fn on_unregister(
        &mut self,
        account_id: AccountId,
        reserve: NearToken,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_ok() {
            return true;
        }
        if !self.accounts.contains_key(&account_id) {
            self.accounts.insert(
                account_id,
                Account {
                    available: NearToken::from_yoctonear(0),
                    locked: NearToken::from_yoctonear(0),
                    storage_reserve: reserve,
                    open_sessions: Vec::new(),
                    receipts: Vec::new(),
                    pending_withdrawals: 0,
                },
            );
        }
        false
    }

    #[private]
    pub fn on_fees_withdrawn(
        &mut self,
        amount: NearToken,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        if result.is_err() {
            self.fees_accrued = self.fees_accrued.saturating_add(amount);
            return false;
        }
        true
    }

    // ---------- views ----------

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner_id: self.owner_id.clone(),
            gateway_id: self.gateway_id.clone(),
            paused: self.paused,
            fees_accrued: self.fees_accrued,
            next_session_id: U64(self.next_session_id),
            storage_reserve: STORAGE_RESERVE,
            min_amount: MIN_AMOUNT,
            max_open_sessions: MAX_OPEN_SESSIONS as u32,
            max_receipts: MAX_RECEIPTS as u32,
            min_ttl_seconds: U64(MIN_TTL_SECONDS),
            max_ttl_seconds: U64(MAX_TTL_SECONDS),
            settle_grace_seconds: U64(SETTLE_GRACE_NS / NS_PER_SECOND),
        }
    }

    pub fn get_balance(&self, account_id: AccountId) -> Option<BalanceView> {
        self.accounts.get(&account_id).map(|a| BalanceView {
            available: a.available,
            locked: a.locked,
            storage_reserve: a.storage_reserve,
            open_sessions: a.open_sessions.iter().map(|id| U64(*id)).collect(),
        })
    }

    pub fn get_session(&self, session_id: U64) -> Option<SessionView> {
        self.sessions.get(&session_id.0).map(|s| SessionView {
            session_id,
            owner: s.owner.clone(),
            cap: s.cap,
            opened_at: U64(s.opened_at),
            expires_at: U64(s.expires_at),
            settle_deadline: U64(s.settle_deadline()),
        })
    }

    pub fn get_receipts(&self, account_id: AccountId) -> Vec<Receipt> {
        self.accounts
            .get(&account_id)
            .map(|a| a.receipts.clone())
            .unwrap_or_default()
    }

    // ---------- internal ----------

    fn assert_owner(&self) {
        require!(
            env::attached_deposit() == ONE_YOCTO,
            "Requires attached deposit of exactly 1 yoctoNEAR"
        );
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Only the owner can call this"
        );
    }

    /// Delete the session, unlock its cap, refund `cap - spent`, and store a receipt.
    fn close_session(
        &mut self,
        id: u64,
        session: &Session,
        spent: NearToken,
        receipt_hash: Option<String>,
        outcome: Outcome,
    ) {
        self.sessions.remove(&id);
        let refunded = sub(session.cap, spent, "Spent exceeds session cap");
        let acc = self
            .accounts
            .get_mut(&session.owner)
            .unwrap_or_else(|| env::panic_str("Session owner not registered"));
        acc.locked = sub(acc.locked, session.cap, "Locked balance underflow");
        acc.available = add(acc.available, refunded);
        acc.open_sessions.retain(|s| *s != id);
        if acc.receipts.len() >= MAX_RECEIPTS {
            acc.receipts.remove(0);
        }
        acc.receipts.push(Receipt {
            session_id: U64(id),
            cap: session.cap,
            spent,
            refunded,
            receipt_hash,
            closed_at: U64(env::block_timestamp()),
            outcome,
        });
    }
}
