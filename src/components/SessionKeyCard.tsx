import { SESSION_KEY_METHODS } from '../config/networks'
import { formatNear } from '../lib/rpc'
import { useNear } from '../wallet/context'
import type { useAccountInfo } from '../wallet/useAccountInfo'

/** Shows whether the limited function-call key ("session key") exists on-chain. */
export function SessionKeyCard({ info }: { info: ReturnType<typeof useAccountInfo> }) {
  const { config } = useNear()
  const keys = info.sessionKeys
  const active = !!keys && keys.length > 0

  return (
    <section className="card">
      <div className="card-head">
        <span className="label">Session key</span>
        <span className={`badge ${active ? 'badge-ok' : keys === null ? 'badge-dim' : 'badge-warn'}`}>
          {keys === null ? (info.error ? 'Unknown' : 'Checking') : active ? 'Active' : 'Not found'}
        </span>
      </div>
      <h3>One approval, then no popups</h3>
      <p className="muted small">
        A function-call access key scoped to <code>{config.contractId}</code>. It can open and reclaim sessions without
        a wallet popup. It cannot move funds.
      </p>
      {active && keys ? (
        <ul className="kv small">
          {keys.map((k) => {
            const p = k.access_key.permission
            const fc = p === 'FullAccess' ? null : p.FunctionCall
            return (
              <li key={k.public_key}>
                <span className="mono truncate" title={k.public_key}>
                  {k.public_key}
                </span>
                <span className="muted">
                  {fc?.method_names.length ? fc.method_names.join(', ') : 'all non-payable methods'}
                  {fc?.allowance ? ` · allowance ${formatNear(fc.allowance)} Ⓝ` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      ) : (
        keys !== null && (
          <p className="small">
            No scoped key on this account yet (some wallets skip it). Reconnect to add one limited to{' '}
            <code>{SESSION_KEY_METHODS.join(', ')}</code>.
          </p>
        )
      )}
      {info.error && <p className="error small">{info.error}</p>}
      <button className="btn btn-sm" onClick={info.refresh} disabled={info.loading}>
        {info.loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </section>
  )
}
