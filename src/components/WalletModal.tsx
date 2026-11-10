import { useEffect, useState } from 'react'
import { SESSION_KEY_METHODS } from '../config/networks'
import { useNear } from '../wallet/context'

export function WalletModal() {
  const { modalOpen, closeModal, modules, signIn, config, status } = useNear()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!modalOpen) {
      setPending(null)
      setError(null)
      return
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeModal()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen, closeModal])

  if (!modalOpen) return null

  const wallets = modules.filter((m) => !m.metadata.deprecated)

  async function connect(id: string) {
    setPending(id)
    setError(null)
    try {
      await signIn(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={closeModal}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="wallet-modal-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="wallet-modal-title">Connect a NEAR wallet</h2>
          <button className="icon-btn" onClick={closeModal} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="muted small">
          Network: <span className={`net-pill net-${config.networkId}`}>{config.label}</span>
        </p>

        {status === 'loading' && <p className="muted">Loading wallets…</p>}

        <ul className="wallet-list">
          {wallets.map((m) => (
            <li key={m.id}>
              <button className="wallet-row" disabled={pending !== null} onClick={() => connect(m.id)}>
                {m.metadata.iconUrl && <img src={m.metadata.iconUrl} alt="" width={32} height={32} />}
                <span className="wallet-name">{m.metadata.name}</span>
                <span className="muted small">{pending === m.id ? 'Waiting for wallet…' : m.type}</span>
              </button>
            </li>
          ))}
        </ul>

        {error && <p className="error small">{error}</p>}

        <div className="callout small">
          <strong>One approval, then no popups.</strong> Signing in adds a limited access key that can only call{' '}
          <code>{SESSION_KEY_METHODS.join(', ')}</code> on <code>{config.contractId}</code>. It cannot move funds:
          deposits and withdrawals always ask your wallet.
        </div>
      </div>
    </div>
  )
}
