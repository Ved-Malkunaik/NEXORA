import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useClient, useNow } from '../client/context'
import type { CreditBalance, PrivacyMode, SessionInfo } from '../client/types'
import { formatNear, parseNear, ratio, tryParseNear } from '../lib/near-amount'
import { useNear } from '../wallet/context'
import { useToast } from './toast'
import { AmountField, Meter, Modal, Near, formatDuration, nsToMs, validateAmount } from './ui'

const RESERVE = parseNear('0.05')
const MIN = parseNear('0.001')
const MAX_OPEN = 4

// ---------- preferences (per browser) ----------

const PREF_MODE = 'nexora:pref:mode'
const PREF_TTL = 'nexora:pref:ttl'
const PREF_CAP = 'nexora:pref:cap'

function readPref(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}
export const prefs = {
  mode: () => (readPref(PREF_MODE, 'B') === 'A' ? 'A' : 'B') as PrivacyMode,
  ttl: () => Number(readPref(PREF_TTL, '3600')),
  cap: () => readPref(PREF_CAP, '0.05'),
  setMode: (m: PrivacyMode) => writePref(PREF_MODE, m),
  setTtl: (s: number) => writePref(PREF_TTL, String(s)),
  setCap: (c: string) => writePref(PREF_CAP, c),
}

export const TTL_OPTIONS = [
  { label: '15 min', s: 900 },
  { label: '1 hour', s: 3600 },
  { label: '4 hours', s: 14_400 },
  { label: '24 hours', s: 86_400 },
]

export const MODE_INFO: Record<PrivacyMode, { short: string; title: string; body: string }> = {
  A: { short: 'Mode A', title: 'Hide who pays', body: 'Preview: zkAPI is not integrated yet, so payment is still linked to your account. You can also send NEAR by asking, for example "send 0.001 NEAR to alice.testnet".' },
  B: { short: 'Mode B', title: 'Hide what you ask', body: 'Runs in a TEE on NEAR AI Cloud. Each answer comes with an attestation.' },
}

// ---------- deposit ----------

export function DepositModal({ open, onClose, balance }: { open: boolean; onClose: () => void; balance: CreditBalance | null | undefined }) {
  const client = useClient()
  const toast = useToast()
  const { accountId } = useNear()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const first = !balance
  const err = validateAmount(value, {
    min: first ? RESERVE + 1n : MIN,
    minLabel: first ? 'Your first deposit must be more than 0.05 NEAR (the storage reserve)' : 'Deposit at least 0.001 NEAR',
  })
  const amt = tryParseNear(value)
  const willHave = amt !== null && amt > 0n ? (first ? amt - RESERVE : amt + BigInt(balance!.available)) : null

  async function submit() {
    if (!accountId || amt === null || err) return
    setBusy(true)
    try {
      const b = await client.deposit(accountId, amt.toString())
      toast.ok('Deposit confirmed', `${formatNear(amt)} NEAR added. ${formatNear(b.available)} NEAR available.`)
      setValue('')
      onClose()
    } catch (e) {
      toast.error('Deposit failed', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      label="Credits"
      title="Deposit NEAR"
      footer={
        <>
          <span className="muted small">Your wallet asks you to approve this deposit.</span>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !value || !!err}>
            {busy ? 'Waiting for wallet…' : 'Deposit'}
          </button>
        </>
      }
    >
      <AmountField
        value={value}
        onChange={setValue}
        presets={first ? ['0.1', '0.5', '1'] : ['0.05', '0.1', '0.5']}
        error={err}
        autoFocus
        hint={
          willHave !== null ? (
            <>
              You will have <strong>{formatNear(willHave)} NEAR</strong> available.
            </>
          ) : first ? (
            'First deposit keeps 0.05 NEAR as a refundable storage reserve.'
          ) : null
        }
      />
      {first && (
        <p className="callout small">
          <strong>First deposit.</strong> 0.05 NEAR pays for your account's on-chain storage. You get it back when you close the account in Settings.
        </p>
      )}
    </Modal>
  )
}

// ---------- withdraw ----------

export function WithdrawModal({ open, onClose, balance }: { open: boolean; onClose: () => void; balance: CreditBalance | null | undefined }) {
  const client = useClient()
  const toast = useToast()
  const { accountId } = useNear()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const available = balance ? BigInt(balance.available) : 0n
  const err = validateAmount(value, { max: available, maxLabel: `Only ${formatNear(available)} NEAR is available (locked credits stay in their sessions)` })
  const amt = tryParseNear(value)

  async function submit() {
    if (!accountId || amt === null || err) return
    setBusy(true)
    try {
      await client.withdraw(accountId, amt.toString())
      toast.ok('Withdrawal sent', `${formatNear(amt)} NEAR is on its way to ${accountId}.`)
      setValue('')
      onClose()
    } catch (e) {
      toast.error('Withdrawal failed', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      label="Credits"
      title="Withdraw to your wallet"
      footer={
        <>
          <span className="muted small">Needs wallet approval (1 yoctoNEAR), so a session key can never withdraw.</span>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !value || !!err || available === 0n}>
            {busy ? 'Waiting for wallet…' : 'Withdraw'}
          </button>
        </>
      }
    >
      <AmountField
        value={value}
        onChange={setValue}
        max={available}
        error={err}
        autoFocus
        hint={
          <>
            Available: <strong>{formatNear(available)} NEAR</strong>
            {balance && BigInt(balance.locked) > 0n && <> · {formatNear(balance.locked)} NEAR locked in sessions</>}
          </>
        }
      />
    </Modal>
  )
}

// ---------- open session ----------

export function OpenSessionModal({
  open,
  onClose,
  balance,
  onOpened,
  defaultMode,
}: {
  open: boolean
  onClose: () => void
  balance: CreditBalance | null | undefined
  onOpened?: (s: SessionInfo) => void
  defaultMode?: PrivacyMode
}) {
  const client = useClient()
  const toast = useToast()
  const { accountId } = useNear()
  const [cap, setCap] = useState(prefs.cap)
  const [ttl, setTtl] = useState(prefs.ttl)
  const [mode, setMode] = useState<PrivacyMode>(defaultMode ?? prefs.mode())
  const [busy, setBusy] = useState(false)
  const available = balance ? BigInt(balance.available) : 0n
  const full = (balance?.open_sessions.length ?? 0) >= MAX_OPEN
  const err = !balance
    ? 'Deposit credits first'
    : full
      ? 'You already have 4 open sessions. End one first.'
      : validateAmount(cap, {
          min: MIN,
          max: available,
          minLabel: 'Cap must be at least 0.001 NEAR',
          maxLabel: `Only ${formatNear(available)} NEAR is available`,
        })

  async function submit() {
    if (!accountId || err) return
    setBusy(true)
    try {
      const s = await client.openSession(accountId, parseNear(cap).toString(), ttl, mode)
      toast.ok(`Session #${s.session_id} open`, `${formatNear(s.cap)} NEAR locked for ${TTL_OPTIONS.find((o) => o.s === ttl)?.label ?? `${ttl}s`}.`)
      onOpened?.(s)
      onClose()
    } catch (e) {
      toast.error('Could not open session', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      label="Session"
      title="Open a chat session"
      footer={
        <>
          <span className="muted small">No wallet popup: signed with your session key.</span>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !cap || !!err}>
            {busy ? 'Opening…' : 'Open session'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="label">Privacy mode</span>
        <div className="mode-pick">
          {(['B', 'A'] as PrivacyMode[]).map((m) => (
            <button key={m} type="button" className={`mode-opt ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)} aria-pressed={mode === m}>
              <span className="label">{MODE_INFO[m].short}</span>
              <strong>{MODE_INFO[m].title}</strong>
              <span className="small muted">{MODE_INFO[m].body}</span>
            </button>
          ))}
        </div>
      </div>
      <AmountField
        label="Spending cap"
        value={cap}
        onChange={setCap}
        presets={['0.01', '0.05', '0.1']}
        error={err}
        hint={<>The most this session can cost. Unspent credits come back when it ends. Available: {formatNear(available)} NEAR</>}
      />
      <div className="field">
        <span className="label">Duration</span>
        <div className="chips">
          {TTL_OPTIONS.map((o) => (
            <button key={o.s} type="button" className={`chip ${ttl === o.s ? 'on' : ''}`} onClick={() => setTtl(o.s)}>
              {o.label}
            </button>
          ))}
        </div>
        <p className="small muted">If the gateway never settles, you can reclaim the full cap 15 minutes after it expires.</p>
      </div>
    </Modal>
  )
}

// ---------- session card ----------

export type SessionPhase = 'active' | 'expired' | 'reclaimable'

export function sessionPhase(s: SessionInfo, now: number): SessionPhase {
  if (now <= nsToMs(s.expires_at)) return 'active'
  if (now <= nsToMs(s.settle_deadline)) return 'expired'
  return 'reclaimable'
}

export function SessionCard({ s, compact = false }: { s: SessionInfo; compact?: boolean }) {
  const client = useClient()
  const toast = useToast()
  const { accountId } = useNear()
  const now = useNow()
  const [busy, setBusy] = useState<'end' | 'reclaim' | null>(null)
  const phase = sessionPhase(s, now)
  const used = ratio(s.metered, s.cap)

  async function end() {
    if (!accountId) return
    setBusy('end')
    try {
      const r = await client.closeSession(accountId, s.session_id)
      toast.ok(`Session #${s.session_id} settled`, `Spent ${formatNear(r.spent)} NEAR, ${formatNear(r.refunded)} NEAR back to your credits.`)
    } catch (e) {
      toast.error('Could not end session', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function reclaim() {
    if (!accountId) return
    setBusy('reclaim')
    try {
      const r = await client.reclaimSession(accountId, s.session_id)
      toast.ok(`Session #${s.session_id} reclaimed`, `${formatNear(r.refunded)} NEAR back to your credits.`)
    } catch (e) {
      toast.error('Could not reclaim', e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const status =
    phase === 'active'
      ? { cls: 'badge-ok', text: `${formatDuration(nsToMs(s.expires_at) - now)} left` }
      : phase === 'expired'
        ? { cls: 'badge-warn', text: `Expired · settle within ${formatDuration(nsToMs(s.settle_deadline) - now)}` }
        : { cls: 'badge-err', text: 'Unsettled · reclaim available' }

  return (
    <article className={`session-card ${compact ? 'compact' : ''}`}>
      <div className="card-head">
        <span className="label">
          Session #{s.session_id} · {MODE_INFO[s.mode].short}
        </span>
        <span className={`badge ${status.cls}`}>{status.text}</span>
      </div>
      <div className="session-nums">
        <span>
          <Near yocto={s.metered} /> <span className="muted small">of</span> <Near yocto={s.cap} />
        </span>
        <span className="muted small">{Math.round(used * 100)}% used</span>
      </div>
      <Meter value={used} label={`Session ${s.session_id} spend`} />
      <div className="row" style={{ marginTop: 12 }}>
        {phase === 'active' && !compact && (
          <Link className="btn btn-sm-inline" to={`/app/chat?session=${s.session_id}`}>
            Chat
          </Link>
        )}
        {phase !== 'reclaimable' ? (
          <button className="btn btn-sm-inline" onClick={end} disabled={busy !== null}>
            {busy === 'end' ? 'Settling…' : 'End & settle'}
          </button>
        ) : (
          <button className="btn btn-primary btn-sm-inline" onClick={reclaim} disabled={busy !== null}>
            {busy === 'reclaim' ? 'Reclaiming…' : `Reclaim ${formatNear(s.cap)} NEAR`}
          </button>
        )}
      </div>
    </article>
  )
}
