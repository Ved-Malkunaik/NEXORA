import { NetworkSwitch } from '../components/NetworkSwitch'
import { PageHeader } from '../components/Layouts'
import { SessionKeyCard } from '../components/SessionKeyCard'
import { SESSION_KEY_METHODS } from '../config/networks'
import { useNear } from '../wallet/context'
import { useAccountInfo } from '../wallet/useAccountInfo'

export function Settings() {
  const { config, accountId, selectedWalletId, signOut, openModal, status } = useNear()
  const info = useAccountInfo()
  return (
    <>
      <PageHeader label="05 · Settings" title="Network and wallet" />
      <div className="grid-2">
        <section className="card">
          <span className="label">Network</span>
          <h3 style={{ marginTop: 6 }}>{config.label}</h3>
          <p className="muted small">Switching reconnects the wallet selector. Each network keeps its own login.</p>
          <NetworkSwitch />
          <ul className="kv kv-row small">
            <li>
              <span className="muted">Contract</span>
              <code className="truncate">{config.contractId}</code>
            </li>
            <li>
              <span className="muted">RPC</span>
              <span className="mono truncate">{config.nodeUrl}</span>
            </li>
            <li>
              <span className="muted">Session key methods</span>
              <span className="mono">{SESSION_KEY_METHODS.join(', ')}</span>
            </li>
          </ul>
        </section>
        <section className="card">
          <span className="label">Wallet</span>
          <h3 style={{ marginTop: 6 }}>{accountId ?? 'Not connected'}</h3>
          <p className="muted small">{accountId ? `Connected with ${selectedWalletId}` : 'Connect to add a session key.'}</p>
          <div className="row">
            {accountId ? (
              <>
                <a className="btn" href={`${config.explorerUrl}/address/${accountId}`} target="_blank" rel="noreferrer">
                  Explorer ↗
                </a>
                <button className="btn" onClick={() => signOut()}>
                  Disconnect
                </button>
              </>
            ) : (
              <button className="btn btn-primary" onClick={openModal} disabled={status !== 'ready'}>
                •• Connect wallet
              </button>
            )}
          </div>
        </section>
      </div>
      {accountId && <SessionKeyCard info={info} />}
    </>
  )
}
