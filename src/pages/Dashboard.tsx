import { Link } from 'react-router-dom'
import { PageHeader, RequireWallet } from '../components/Layouts'
import { SessionKeyCard } from '../components/SessionKeyCard'
import { formatNear } from '../lib/rpc'
import { useNear } from '../wallet/context'
import { useAccountInfo } from '../wallet/useAccountInfo'

export function Dashboard() {
  const { accountId, config } = useNear()
  const info = useAccountInfo()

  return (
    <>
      <PageHeader
        label="01 · Dashboard"
        title="Your private balance"
        subtitle={accountId ? `Signed in as ${accountId} on ${config.label.toLowerCase()}` : 'Credits, sessions and your session key'}
      />
      <RequireWallet what="see your dashboard">
        <div className="grid-3">
          <section className="card stat">
            <span className="label">Wallet balance</span>
            <strong className="stat-value">{info.account ? `${formatNear(info.account.amount)} Ⓝ` : info.loading ? '…' : '—'}</strong>
            <span className="muted small">{config.label}</span>
          </section>
          <section className="card stat">
            <span className="label">Nexora credits</span>
            <strong className="stat-value">—</strong>
            <span className="muted small">Shown once the credits contract is deployed</span>
          </section>
          <section className="card stat">
            <span className="label">Open sessions</span>
            <strong className="stat-value">0</strong>
            <span className="muted small">Capped and time-limited</span>
          </section>
        </div>

        <div className="grid-2">
          <SessionKeyCard info={info} />
          <section className="card">
            <span className="label">Credits</span>
            <h3 style={{ marginTop: 6 }}>Deposit, chat, withdraw</h3>
            <p className="muted small">
              Deposit NEAR to fund private chats. Anything not locked in a session can be withdrawn at any time.
            </p>
            <div className="row">
              <button className="btn btn-primary" disabled title="Arrives with the credits contract">
                Deposit
              </button>
              <button className="btn" disabled title="Arrives with the credits contract">
                Withdraw
              </button>
              <Link className="btn" to="/app/funding">
                Fund via Intents
              </Link>
            </div>
          </section>
        </div>
      </RequireWallet>
    </>
  )
}
