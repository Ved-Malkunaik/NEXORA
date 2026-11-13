import { useState } from 'react'
import { useClient, useClientQuery, useClientVersion, useMockControls, useNow } from '../client/context'
import { GATEWAY_URL, fetchGatewayHealth, type GatewayHealth } from '../client/live'
import type { PrivacyMode } from '../client/types'
import { MODE_INFO, TTL_OPTIONS, prefs } from '../components/actions'
import { PageHeader } from '../components/Layouts'
import { NetworkSwitch } from '../components/NetworkSwitch'
import { SessionKeyCard } from '../components/SessionKeyCard'
import { useToast } from '../components/toast'
import { AmountField, MockBadge, Modal, Near, formatTime, validateAmount } from '../components/ui'
import { SESSION_KEY_METHODS } from '../config/networks'
import { useNear } from '../wallet/context'
import { useAccountInfo } from '../wallet/useAccountInfo'

export function Settings() {
  const { config, accountId, selectedWalletId, signOut, openModal, status, isDemo } = useNear()
  const info = useAccountInfo()
  return (
    <>
      <PageHeader label="05 · Settings" title="Network, wallet and privacy">
        <MockBadge />
      </PageHeader>
      <div className="grid-2">
        <section className="card">
          <span className="label">Network</span>
          <h3 style={{ marginTop: 6 }}>{config.label}</h3>
          <p className="muted small">Switching reconnects the wallet selector. Each network keeps its own login.</p>
          <NetworkSwitch />
          <ul className="kv kv-row small">
            <li>
              <span className="muted">Contract</span>
              <a className="mono truncate" href={`${config.explorerUrl}/address/${config.contractId}`} target="_blank" rel="noreferrer">
                {config.contractId} ↗
              </a>
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
          <p className="muted small">
            {isDemo ? 'Demo account: simulated, not on-chain.' : accountId ? `Connected with ${selectedWalletId}` : 'Connect to add a session key.'}
          </p>
          <div className="row">
            {accountId ? (
              <>
                {!isDemo && (
                  <a className="btn" href={`${config.explorerUrl}/address/${accountId}`} target="_blank" rel="noreferrer">
                    Explorer ↗
                  </a>
                )}
                <button className="btn" onClick={() => signOut()}>
                  {isDemo ? 'Exit demo' : 'Disconnect'}
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

      <div className="grid-2">
        <PrivacyDefaults />
        {accountId ? <SessionKeyCard info={info} /> : <section className="card muted small">Connect a wallet to see your session key.</section>}
      </div>

      <div className="grid-2">
        <GatewayCard />
        <DevPanel />
        {accountId && <CloseAccount accountId={accountId} />}
      </div>
    </>
  )
}

function PrivacyDefaults() {
  const toast = useToast()
  const [mode, setMode] = useState<PrivacyMode>(prefs.mode)
  const [cap, setCap] = useState(prefs.cap)
  const [ttl, setTtl] = useState(prefs.ttl)
  const capErr = validateAmount(cap, { min: 10n ** 21n, minLabel: 'At least 0.001 NEAR' })

  return (
    <section className="card">
      <span className="label">Privacy defaults</span>
      <h3 style={{ marginTop: 6 }}>For new sessions</h3>
      <label className="toggle-row">
        <input type="checkbox" checked={mode === 'A'} onChange={(e) => setMode(e.target.checked ? 'A' : 'B')} />
        <span>
          <strong>Pay privately with a note by default</strong>
          <span className="small muted">{MODE_INFO.A.body}{mode === 'B' ? ' Off: chat only, paid from your credits and linked to your account on-chain.' : ''}</span>
        </span>
      </label>
      <AmountField label="Default cap" value={cap} onChange={setCap} presets={['0.01', '0.05', '0.1']} error={capErr} />
      <div className="field">
        <span className="label">Default duration</span>
        <div className="chips">
          {TTL_OPTIONS.map((o) => (
            <button key={o.s} className={`chip ${ttl === o.s ? 'on' : ''}`} onClick={() => setTtl(o.s)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <button
        className="btn btn-primary"
        disabled={!!capErr || !cap}
        onClick={() => {
          prefs.setMode(mode)
          prefs.setCap(cap)
          prefs.setTtl(ttl)
          toast.ok('Defaults saved', 'New sessions will start with these settings.')
        }}
      >
        Save defaults
      </button>
      <p className="small muted" style={{ marginTop: 10 }}>Stored in this browser only.</p>
    </section>
  )
}

function DevPanel() {
  const mock = useMockControls()
  const toast = useToast()
  useClientVersion()
  const now = useNow()
  const [confirmReset, setConfirmReset] = useState(false)
  if (!mock) return null
  const offset = mock.getTimeOffsetMs()
  return (
    <section className="card dev-card">
      <div className="card-head">
        <span className="label">Developer · mock client</span>
        <MockBadge />
      </div>
      <p className="muted small">Level 2 runs on simulated data so every screen and state can be tried. These controls disappear when the live client lands in Level 3.</p>
      <label className="toggle">
        <input type="checkbox" checked={mock.failing()} onChange={(e) => mock.setFailing(e.target.checked)} />
        <span>Simulate network and gateway failures</span>
      </label>
      <div className="field">
        <span className="label">Mock clock: {formatTime(now)}{offset ? ` (+${Math.round(offset / 60000)} min)` : ''}</span>
        <div className="chips">
          {[
            ['+5 min', 300],
            ['+1 hour', 3600],
            ['+25 hours', 90_000],
          ].map(([l, s]) => (
            <button key={l} className="chip" onClick={() => (mock.advanceTime(s as number), toast.info('Time moved', `Mock clock advanced ${l}.`))}>
              {l}
            </button>
          ))}
        </div>
        <p className="small muted">Move time forward to see sessions expire and become reclaimable.</p>
      </div>
      <button className="btn" onClick={() => setConfirmReset(true)}>
        Reset mock data
      </button>
      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset mock data?"
        label="Developer"
        footer={
          <button
            className="btn btn-primary"
            onClick={() => {
              mock.reset()
              setConfirmReset(false)
              toast.ok('Mock data reset')
            }}
          >
            Reset
          </button>
        }
      >
        <p>This clears simulated balances, sessions, chats and receipts on this network, in this browser. Nothing on-chain changes.</p>
      </Modal>
    </section>
  )
}

function CloseAccount({ accountId }: { accountId: string }) {
  const client = useClient()
  const toast = useToast()
  const b = useClientQuery((c) => c.getBalance(accountId), [accountId])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const bal = b.data
  const blocker = !bal
    ? null
    : bal.open_sessions.length > 0
      ? 'End your open sessions first.'
      : BigInt(bal.available) > 0n
        ? 'Withdraw your available credits first.'
        : null

  if (!bal) return null
  return (
    <section className="card danger-card">
      <span className="label">Credits account</span>
      <h3 style={{ marginTop: 6 }}>Close and get the reserve back</h3>
      <p className="muted small">
        Removes your account from the contract and returns the <Near yocto={bal.storage_reserve} /> storage reserve. Receipts are deleted with it.
      </p>
      <p className={`small ${blocker ? 'error' : 'muted'}`}>{blocker ?? 'Ready to close.'}</p>
      <button className="btn" disabled={!!blocker} onClick={() => setOpen(true)}>
        Close credits account
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        label="Credits account"
        title="Close your credits account?"
        footer={
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await client.unregister(accountId)
                toast.ok('Account closed', 'Your storage reserve is on its way back.')
                setOpen(false)
              } catch (e) {
                toast.error('Could not close account', e instanceof Error ? e.message : String(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Waiting for wallet…' : 'Close account'}
          </button>
        }
      >
        <p>Your receipt history in the contract is deleted. You can register again later with a new deposit.</p>
      </Modal>
    </section>
  )
}

function GatewayCard() {
  const client = useClient()
  const [tick, setTick] = useState(0)
  const health = useClientQuery<GatewayHealth | null>((c) => (c.kind === 'live' ? fetchGatewayHealth() : Promise.resolve(null)), [tick])
  if (client.kind !== 'live') return null
  const h = health.data
  return (
    <section className="card">
      <div className="card-head">
        <span className="label">Gateway</span>
        <span className={`badge ${h?.can_settle ? 'badge-ok' : h ? 'badge-warn' : 'badge-err'}`}>
          {h ? (h.can_settle ? 'Ready' : 'No settle key') : health.loading ? 'Checking' : 'Offline'}
        </span>
      </div>
      <h3>Meters chat and settles sessions</h3>
      <p className="muted small">
        <code>{GATEWAY_URL}</code>
      </p>
      {health.error && <p className="error small">{health.error}</p>}
      {h && (
        <ul className="kv kv-row small">
          <li>
            <span className="muted">Settles as</span>
            <span className="mono">{h.gateway ?? 'not configured'}</span>
          </li>
          <li>
            <span className="muted">Contract</span>
            <span className="mono">{h.contract}</span>
          </li>
          <li>
            <span className="muted">Model</span>
            <span>{h.model}</span>
          </li>
          {h.provider && (
            <li>
              <span className="muted">Runs on</span>
              <span>
                {h.provider === 'openrouter' ? 'OpenRouter (not in a TEE)' : h.provider === 'nearai' ? 'NEAR AI Cloud (TEE)' : 'Simulated'}
                {h.models && h.models.length > 1 ? ` · fallbacks: ${h.models.slice(1).join(', ')}` : ''}
              </span>
            </li>
          )}
          {h.limits && (
            <li>
              <span className="muted">Free-tier use</span>
              <span>
                {h.limits.today} of {h.limits.per_day} requests today · {h.limits.last_minute}/{h.limits.per_minute} this minute
              </span>
            </li>
          )}
          {h.attested_model && (
            <li>
              <span className="muted">TEE attestation</span>
              <span>
                <span className="mono">{h.attested_model}</span> ·{' '}
                {h.attestation_verified === true ? 'verified' : h.attestation_verified === false ? 'failed' : 'checked on first chat'}
              </span>
            </li>
          )}
        </ul>
      )}
      {h && h.model_live === false && <p className="small muted">Replies are simulated: set OPENROUTER_API_KEY in gateway/.env for real answers.</p>}
      {h && !h.can_settle && <p className="small error">Add GATEWAY_ACCOUNT_ID and GATEWAY_PRIVATE_KEY to gateway/.env and restart it.</p>}
      <button className="btn btn-sm" onClick={() => setTick((t) => t + 1)}>
        Check again
      </button>
    </section>
  )
}
