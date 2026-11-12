//! Sandbox integration tests: real wasm, real runtime, real promises.
//! The NEAR sandbox has no Windows build, so these run on Linux/macOS only (CI or Docker).
#![cfg(not(windows))]
// Test helpers hold the sandbox handle across awaits; Send-ness of these futures is irrelevant here.
#![allow(clippy::future_not_send)]

use near_api::signer::generate_secret_key;
use near_api::types::AccessKeyPermission;
use near_api::types::transaction::actions::FunctionCallPermission;
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{Value, json};
use std::sync::Arc;

type R<T = ()> = testresult::TestResult<T>;

const HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

struct Env {
    sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    contract: near_api::Contract,
    owner: AccountId,
    gateway: AccountId,
    alice: AccountId,
    bob: AccountId,
}

async fn create(sandbox: &near_sandbox::Sandbox, name: &str, near: u128) -> R<AccountId> {
    let id: AccountId = name.parse()?;
    sandbox
        .create_account(id.as_str().parse()?)
        .initial_balance(NearToken::from_near(near))
        .send()
        .await?;
    Ok(id)
}

async fn setup() -> R<Env> {
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    // Sandbox-created accounts share the genesis key.
    let signer = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;

    let owner = create(&sandbox, "owner.sandbox", 10).await?;
    let gateway = create(&sandbox, "gateway.sandbox", 10).await?;
    let alice = create(&sandbox, "alice.sandbox", 20).await?;
    let bob = create(&sandbox, "bob.sandbox", 20).await?;
    let contract_id = create(&sandbox, "credits.sandbox", 20).await?;

    near_api::Contract::deploy(contract_id.clone())
        .use_code(wasm)
        .with_init_call("new", json!({ "owner_id": owner, "gateway_id": gateway }))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    Ok(Env {
        sandbox,
        net,
        signer,
        contract: near_api::Contract(contract_id),
        owner,
        gateway,
        alice,
        bob,
    })
}

impl Env {
    async fn call(
        &self,
        who: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> R<near_api::types::transaction::result::TransactionResult> {
        Ok(self
            .contract
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .gas(NearGas::from_tgas(100))
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn ok(&self, who: &AccountId, method: &str, args: Value, deposit: NearToken) -> R<Value> {
        let res = self.call(who, method, args, deposit).await?;
        let out = res.assert_success();
        Ok(out.json::<Value>().unwrap_or(Value::Null))
    }

    /// Expect a contract panic whose message contains `msg`.
    async fn fails(
        &self,
        who: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
        msg: &str,
    ) -> R {
        let res = self.call(who, method, args, deposit).await?;
        let err = format!("{:?}", res.assert_failure());
        assert!(err.contains(msg), "expected `{msg}` in failure, got: {err}");
        Ok(())
    }

    async fn view(&self, method: &str, args: Value) -> R<Value> {
        Ok(self
            .contract
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn balance(&self, who: &AccountId) -> R<Value> {
        self.view("get_balance", json!({ "account_id": who })).await
    }

    async fn near_balance(&self, who: &AccountId) -> R<NearToken> {
        Ok(near_api::Account(who.clone())
            .tokens()
            .near_balance()
            .fetch_from(&self.net)
            .await?
            .total)
    }
}

fn yocto(v: &Value) -> u128 {
    v.as_str()
        .expect("NearToken is a JSON string")
        .parse()
        .unwrap()
}
const fn milli(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}
const fn zero() -> NearToken {
    NearToken::from_yoctonear(0)
}
const fn one_yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}

#[tokio::test]
async fn session_lifecycle_and_access_control() -> R {
    let e = setup().await?;
    let (alice, bob, gateway, owner) = (&e.alice, &e.bob, &e.gateway, &e.owner);

    // Deposit 2 NEAR: 0.05 goes to the storage reserve.
    e.ok(alice, "deposit", json!({}), NearToken::from_near(2))
        .await?;
    let b = e.balance(alice).await?;
    assert_eq!(yocto(&b["available"]), milli(1950).as_yoctonear());

    // Open a session with cap 0.5 NEAR.
    let id = e
        .ok(
            alice,
            "open_session",
            json!({ "cap": milli(500), "ttl_seconds": "600" }),
            zero(),
        )
        .await?;
    let id = id.as_str().unwrap().to_string();
    assert_eq!(
        yocto(&e.balance(alice).await?["locked"]),
        milli(500).as_yoctonear()
    );

    // Unauthorized callers cannot settle.
    let settle =
        |spent: NearToken| json!({ "session_id": id, "spent": spent, "receipt_hash": HASH });
    e.fails(
        alice,
        "settle_session",
        settle(milli(1)),
        zero(),
        "Only the gateway can settle",
    )
    .await?;
    e.fails(
        owner,
        "settle_session",
        settle(milli(1)),
        zero(),
        "Only the gateway can settle",
    )
    .await?;
    // Cap exceeded.
    e.fails(
        gateway,
        "settle_session",
        settle(milli(501)),
        zero(),
        "Spent exceeds session cap",
    )
    .await?;
    // Reclaim too early.
    e.fails(
        alice,
        "reclaim_session",
        json!({ "session_id": id }),
        zero(),
        "settle deadline",
    )
    .await?;

    // Gateway settles 0.12 NEAR.
    e.ok(gateway, "settle_session", settle(milli(120)), zero())
        .await?;
    let b = e.balance(alice).await?;
    assert_eq!(yocto(&b["locked"]), 0);
    assert_eq!(yocto(&b["available"]), milli(1830).as_yoctonear());
    assert_eq!(
        yocto(&e.view("get_config", json!({})).await?["fees_accrued"]),
        milli(120).as_yoctonear()
    );

    // Double settle and settle-then-reclaim are impossible.
    e.fails(
        gateway,
        "settle_session",
        settle(milli(1)),
        zero(),
        "Session not found or already closed",
    )
    .await?;
    e.fails(
        alice,
        "reclaim_session",
        json!({ "session_id": id }),
        zero(),
        "Session not found or already closed",
    )
    .await?;

    let receipts = e
        .view("get_receipts", json!({ "account_id": alice }))
        .await?;
    assert_eq!(receipts.as_array().unwrap().len(), 1);
    assert_eq!(receipts[0]["outcome"], "Settled");
    assert_eq!(receipts[0]["receipt_hash"], HASH);

    // Callbacks are private.
    e.fails(
        bob,
        "on_withdraw",
        json!({ "account_id": bob, "amount": NearToken::from_near(5) }),
        zero(),
        "is private",
    )
    .await?;

    // Admin functions: owner only, 1 yocto.
    e.fails(
        alice,
        "set_paused",
        json!({ "paused": true }),
        one_yocto(),
        "Only the owner",
    )
    .await?;
    e.fails(
        owner,
        "set_paused",
        json!({ "paused": true }),
        zero(),
        "exactly 1 yoctoNEAR",
    )
    .await?;
    e.ok(owner, "set_paused", json!({ "paused": true }), one_yocto())
        .await?;
    e.fails(
        bob,
        "deposit",
        json!({}),
        NearToken::from_near(1),
        "Contract is paused",
    )
    .await?;
    e.ok(owner, "set_paused", json!({ "paused": false }), one_yocto())
        .await?;
    Ok(())
}

#[tokio::test]
async fn expired_sessions_reclaim_and_settlement_window() -> R {
    let e = setup().await?;
    let (alice, gateway) = (&e.alice, &e.gateway);
    e.ok(alice, "deposit", json!({}), NearToken::from_near(2))
        .await?;
    let a = e
        .ok(
            alice,
            "open_session",
            json!({ "cap": milli(300), "ttl_seconds": "60" }),
            zero(),
        )
        .await?;
    let b = e
        .ok(
            alice,
            "open_session",
            json!({ "cap": milli(200), "ttl_seconds": "60" }),
            zero(),
        )
        .await?;

    // Advance past expires_at + 15 min grace: retry until reclaim opens.
    let mut reclaimed = false;
    for _ in 0..40 {
        e.sandbox.fast_forward(500).await?;
        if e.call(alice, "reclaim_session", json!({ "session_id": a }), zero())
            .await?
            .is_success()
        {
            reclaimed = true;
            break;
        }
    }
    assert!(reclaimed, "reclaim never opened");

    // Past the deadline the gateway can no longer settle; the user reclaims instead.
    e.fails(
        gateway,
        "settle_session",
        json!({ "session_id": b, "spent": milli(1), "receipt_hash": HASH }),
        zero(),
        "Settlement window has closed",
    )
    .await?;
    e.ok(alice, "reclaim_session", json!({ "session_id": b }), zero())
        .await?;

    let bal = e.balance(alice).await?;
    assert_eq!(yocto(&bal["available"]), milli(1950).as_yoctonear());
    assert_eq!(yocto(&bal["locked"]), 0);
    Ok(())
}

#[tokio::test]
async fn withdraw_and_unregister_move_real_near() -> R {
    let e = setup().await?;
    let alice = &e.alice;
    e.ok(alice, "deposit", json!({}), NearToken::from_near(2))
        .await?;

    e.fails(
        alice,
        "withdraw",
        json!({ "amount": milli(100) }),
        zero(),
        "exactly 1 yoctoNEAR",
    )
    .await?;
    e.fails(
        alice,
        "withdraw",
        json!({ "amount": NearToken::from_near(2) }),
        one_yocto(),
        "Not enough available credits",
    )
    .await?;

    let before = e.near_balance(alice).await?;
    e.ok(
        alice,
        "withdraw",
        json!({ "amount": milli(1950) }),
        one_yocto(),
    )
    .await?;
    let after = e.near_balance(alice).await?;
    // Received 1.95 NEAR minus gas (well under 0.05 NEAR).
    assert!(
        after > before.saturating_add(milli(1900)),
        "before {before}, after {after}"
    );
    assert_eq!(yocto(&e.balance(alice).await?["available"]), 0);

    // Empty account can unregister and gets the 0.05 NEAR reserve back.
    e.ok(alice, "unregister", json!({}), one_yocto()).await?;
    assert!(e.balance(alice).await?.is_null());
    Ok(())
}

/// The account-abstraction path from the app: a function-call key limited to
/// open_session / reclaim_session works without the wallet, but cannot move funds.
#[tokio::test]
async fn session_key_can_open_but_not_withdraw() -> R {
    let e = setup().await?;
    let alice = &e.alice;
    e.ok(alice, "deposit", json!({}), NearToken::from_near(2))
        .await?;

    let sk = generate_secret_key()?;
    near_api::Account(alice.clone())
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: Some(milli(250)),
                receiver_id: e.contract.0.to_string(),
                method_names: vec!["open_session".into(), "reclaim_session".into()],
            }),
            sk.public_key(),
        )
        .with_signer(e.signer.clone())
        .send_to(&e.net)
        .await?
        .assert_success();
    let session_signer = Signer::from_secret_key(sk)?;

    // Allowed method, no deposit: works with the session key.
    let res = e
        .contract
        .call_function(
            "open_session",
            json!({ "cap": milli(100), "ttl_seconds": "600" }),
        )
        .transaction()
        .gas(NearGas::from_tgas(30))
        .with_signer(alice.clone(), session_signer.clone())
        .send_to(&e.net)
        .await?;
    assert!(res.is_success(), "session key should open a session");

    // withdraw needs a deposit and is not in method_names: rejected before or during execution.
    let res = e
        .contract
        .call_function("withdraw", json!({ "amount": milli(100) }))
        .transaction()
        .deposit(one_yocto())
        .gas(NearGas::from_tgas(30))
        .with_signer(alice.clone(), session_signer.clone())
        .send_to(&e.net)
        .await;
    assert!(
        res.map(|r| r.is_failure()).unwrap_or(true),
        "session key must not withdraw"
    );
    assert_eq!(
        yocto(&e.balance(alice).await?["available"]),
        milli(1850).as_yoctonear()
    );
    Ok(())
}
