import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatNear, tryParseNear } from '../lib/near-amount'
import { useMockControls } from '../client/context'

// ---------- modal ----------

export function Modal({
  open,
  onClose,
  title,
  label,
  children,
  footer,
  busy = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  label?: string
  children: ReactNode
  footer?: ReactNode
  busy?: boolean
}) {
  const id = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])
  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            {label && <span className="label muted">{label}</span>}
            <h2 id={id}>{title}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

// ---------- amount input ----------

/** NEAR amount field with presets, "Max" and inline validation. */
export function AmountField({
  value,
  onChange,
  label = 'Amount',
  max,
  presets = [],
  hint,
  error,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  label?: string
  max?: bigint
  presets?: string[]
  hint?: ReactNode
  error?: string | null
  autoFocus?: boolean
}) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className={`amount-input ${error ? 'invalid' : ''}`}>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value.replace(',', '.'))}
          aria-invalid={!!error}
          aria-describedby={`${id}-msg`}
        />
        <span className="unit">NEAR</span>
        {max !== undefined && (
          <button type="button" className="chip" onClick={() => onChange(formatNear(max, 24).replace(/,/g, ''))}>
            Max
          </button>
        )}
      </div>
      {presets.length > 0 && (
        <div className="chips">
          {presets.map((p) => (
            <button key={p} type="button" className={`chip ${value === p ? 'on' : ''}`} onClick={() => onChange(p)}>
              {p}
            </button>
          ))}
        </div>
      )}
      <p id={`${id}-msg`} className={`small ${error ? 'error' : 'muted'}`}>
        {error || hint || ' '}
      </p>
    </div>
  )
}

/** Shared validation: returns an error message or null. */
export function validateAmount(
  value: string,
  { min, max, minLabel, maxLabel }: { min?: bigint; max?: bigint; minLabel?: string; maxLabel?: string },
): string | null {
  if (!value) return null
  const v = tryParseNear(value)
  if (v === null) return 'Enter an amount like 0.25'
  if (v <= 0n) return 'Enter an amount greater than 0'
  if (min !== undefined && v < min) return minLabel ?? `Minimum is ${formatNear(min)} NEAR`
  if (max !== undefined && v > max) return maxLabel ?? `Maximum is ${formatNear(max)} NEAR`
  return null
}

// ---------- small pieces ----------

export function Skeleton({ w = '100%', h = 18 }: { w?: string | number; h?: number }) {
  return <span className="skeleton" style={{ width: w, height: h }} aria-hidden="true" />
}

export function Near({ yocto, decimals = 4 }: { yocto: string | bigint; decimals?: number }) {
  return (
    <span className="near-amt">
      {formatNear(yocto, decimals)} <span className="unit">Ⓝ</span>
    </span>
  )
}

export function Meter({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(value * 100)
  return (
    <div className="meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <i style={{ width: `${pct}%` }} className={value >= 0.9 ? 'hot' : ''} />
    </div>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  const t = useRef<number>(0)
  return (
    <button
      type="button"
      className="chip"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          clearTimeout(t.current)
          t.current = window.setTimeout(() => setDone(false), 1400)
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card state-card" role="alert">
      <span className="label error">Something went wrong</span>
      <p>{message}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

export function EmptyState({ label, title, children }: { label: string; title: string; children?: ReactNode }) {
  return (
    <div className="card empty">
      <span className="label">{label}</span>
      <h3 style={{ marginTop: 10 }}>{title}</h3>
      {children}
    </div>
  )
}

/** Shown on every screen while the app runs on mock data, so nothing is mistaken for live. */
export function MockBadge() {
  const mock = useMockControls()
  if (!mock) return null
  return (
    <span className="badge badge-mock" title="Level 2 runs on a mock client. Balances, chats and proofs are simulated.">
      Mock data
    </span>
  )
}

// ---------- time ----------

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec.toString().padStart(2, '0')}s`
  return `${sec}s`
}

export const nsToMs = (ns: string) => Number(BigInt(ns) / 1_000_000n)

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function shortHash(h: string, n = 8) {
  return h.length > n * 2 + 1 ? `${h.slice(0, n)}…${h.slice(-n)}` : h
}
