import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useClientQuery } from '../client/context'
import { DepositModal, OpenSessionModal, SessionCard, WithdrawModal } from '../components/actions'
import { PageHeader, RequireWallet } from '../components/Layouts'
import { SessionKeyCard } from '../components/SessionKeyCard'
import { ErrorState, MockBadge, Near, Skeleton, formatTime, nsToMs, shortHash } from '../components/ui'
import { useNear } from '../wallet/context'
import { useAccountInfo } from '../wallet/useAccountInfo'

export function Dashboard() {
  const { accountId, config } = useNear()
  return (
    <>
      <PageHeader
        label="01 · Dashboard"
        title="Your private balance"
        subtitle={accountId ? `Signed in as ${accountId} on ${config.label.toLowerCase()}` : 'Credits, sessions and your session key'}
      >
        <MockBadge />
      </PageHeader>
      <RequireWallet what="see your dashboard">{accountId && <DashboardBody accountId={accountId} />}</RequireWallet>
    </>
  )
}

function DashboardBody({ accountId }: { accountId: string }) {
  const { isDemo } = useNear()
  const info = useAccountInfo()
  const balance = useClientQuery((c) => c.getBalance(accountId), [accountId])
  const sessions = useClientQuery((c) => c.getSessions(accountId), [accountId])
  const receipts = useClientQuery((c) => c.getReceipts(accountId), [accountId])
  const [modal, setModal] = useState<'deposit' | 'withdraw' | 'open' | null>(null)
  const b = balance.data
  const registered = b !== null && b !== undefined

  return (
    <>
      {balance.error && !b && <ErrorState message={balance.error} onRetry={balance.reload} />}

      <div className="grid-3">
        <section className="card stat">
          <span className="label">Available credits</span>
          <strong className="stat-value">{balance.loading ? <Skeleton w="60%" h={34} /> : <Near yocto={b?.available ?? '0'} />}</strong>
          <span className="muted small">Ready for new sessions or withdrawal</span>
        </section>
        <section className="card stat">
          <span className="label">Locked in sessions</span>
          <strong className="stat-value">{balance.loading ? <Skeleton w="50%" h={34} /> : <Near yocto={b?.locked ?? '0'} />}</strong>
          <span className="muted small">
            {sessions.data ? `${sessions.data.length} open of 4` : '…'} · unspent returns when a session ends
          </span>
        </section>
        <section className="card stat">
          <span className="label">Wallet balance</span>
          <strong className="stat-value">{info.account ? <Near yocto={info.account.amount} decimals={3} /> : info.loading ? <Skeleton w="55%" h={34} /> : '—'}</strong>
          <span className="muted small">{isDemo ? 'Demo account · no on-chain wallet' : `${accountId} · live from chain`}</span>
        </section>
      </div>

      <section className="card action-bar">
        <div>
          <span className="label">Credits</span>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            {registered
              ? `Storage reserve ${'0.05'} NEAR is held for your account and refunded when you close it.`
              : 'Deposit once to start. The first 0.05 NEAR is a refundable storage reserve.'}
          </p>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={() => setModal('deposit')}>
            Deposit
          </button>
          <button className="btn" onClick={() => setModal('withdraw')} disabled={!registered || BigInt(b?.available ?? '0') === 0n}>
            Withdraw
          </button>
          <Link className="btn" to="/app/funding">
            Fund via Intents
          </Link>
        </div>
      </section>

      <div className="section-head">
        <h2>Open sessions</h2>
        <button className="btn" onClick={() => setModal('open')} disabled={!registered || (b?.open_sessions.length ?? 0) >= 4}>
          + Open session
        </button>
      </div>
      {sessions.loading ? (
        <div className="grid-2">
          <div className="card">
            <Skeleton h={90} />
          </div>
          <div className="card">
            <Skeleton h={90} />
          </div>
        </div>
      ) : sessions.error ? (
        <ErrorState message={sessions.error} onRetry={sessions.reload} />
      ) : sessions.data && sessions.data.length > 0 ? (
        <div className="grid-2">
          {sessions.data.map((s) => (
            <SessionCard key={s.session_id} s={s} />
          ))}
        </div>
      ) : (
        <div className="card empty slim">
          <p className="muted" style={{ margin: 0 }}>
            {registered
              ? 'No open sessions. Open one to lock a spending cap and start chatting.'
              : 'Deposit credits first, then open a session to start chatting.'}
          </p>
        </div>
      )}

      <div className="grid-2" style={{ marginTop: 14 }}>
        <SessionKeyCard info={info} />
        <section className="card">
          <div className="card-head">
            <span className="label">Recent receipts</span>
            <Link to="/app/receipts" className="small">
              All receipts →
            </Link>
          </div>
          {receipts.loading ? (
            <Skeleton h={80} />
          ) : receipts.data && receipts.data.length > 0 ? (
            <ul className="kv kv-row small">
              {[...receipts.data]
                .reverse()
                .slice(0, 4)
                .map((r) => (
                  <li key={r.session_id}>
                    <span>
                      #{r.session_id} · {r.outcome} · <span className="muted">{formatTime(nsToMs(r.closed_at))}</span>
                      <br />
                      <span className="mono muted">{r.receipt_hash ? shortHash(r.receipt_hash) : 'no hash (reclaimed)'}</span>
                    </span>
                    <span>
                      <Near yocto={r.spent} /> spent
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="muted small">Settled sessions show up here with their receipt hash. Chat content is never stored.</p>
          )}
        </section>
      </div>

      <DepositModal open={modal === 'deposit'} onClose={() => setModal(null)} balance={b} />
      <WithdrawModal open={modal === 'withdraw'} onClose={() => setModal(null)} balance={b} />
      <OpenSessionModal open={modal === 'open'} onClose={() => setModal(null)} balance={b} />
    </>
  )
}
