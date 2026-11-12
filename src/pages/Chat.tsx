import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useClient, useClientQuery, useNow } from '../client/context'
import { GATEWAY_URL, fetchGatewayHealth, type GatewayHealth } from '../client/live'
import type { ChatMessage, PrivacyMode, Proof, RecipientStatus, SessionInfo } from '../client/types'
import { MODE_INFO, OpenSessionModal, SessionCard, prefs, sessionPhase } from '../components/actions'
import { PageHeader, RequireWallet } from '../components/Layouts'
import { useToast } from '../components/toast'
import { CopyButton, EmptyState, ErrorState, MockBadge, Modal, Near, Skeleton, formatTime, shortHash } from '../components/ui'
import { parseTransfer, type TransferIntent } from '../lib/transferIntent'
import { useNear } from '../wallet/context'

export function Chat() {
  const { accountId } = useNear()
  const [mode, setMode] = useState<PrivacyMode>(prefs.mode)
  return (
    <>
      <PageHeader label="02 · Chat" title="Private chat" subtitle={MODE_INFO[mode].body}>
        <div className="row">
          <MockBadge />
          <div className="segmented" role="radiogroup" aria-label="Privacy mode for new sessions">
            {(['A', 'B'] as PrivacyMode[]).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                onClick={() => {
                  setMode(m)
                  prefs.setMode(m)
                }}
                title={MODE_INFO[m].title}
              >
                {MODE_INFO[m].short} · {MODE_INFO[m].title}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>
      <LiveNotice />
      <RequireWallet what="start a private chat">{accountId && <ChatBody accountId={accountId} mode={mode} />}</RequireWallet>
    </>
  )
}

function ChatBody({ accountId, mode }: { accountId: string; mode: PrivacyMode }) {
  const [params, setParams] = useSearchParams()
  const balance = useClientQuery((c) => c.getBalance(accountId), [accountId])
  const sessions = useClientQuery((c) => c.getSessions(accountId), [accountId])
  const now = useNow()
  const [openModal, setOpenModal] = useState(false)

  const active = useMemo(() => (sessions.data ?? []).filter((s) => sessionPhase(s, now) === 'active'), [sessions.data, now])
  const wanted = params.get('session')
  const selected: SessionInfo | undefined =
    (sessions.data ?? []).find((s) => s.session_id === wanted) ?? active[active.length - 1] ?? (sessions.data ?? [])[0]

  const select = (id: string) => setParams({ session: id }, { replace: true })

  if (sessions.loading || balance.loading)
    return (
      <div className="chat-layout">
        <div className="card chat">
          <Skeleton h={260} />
        </div>
        <div className="card">
          <Skeleton h={160} />
        </div>
      </div>
    )
  const loadError = sessions.error ?? (balance.data === undefined ? balance.error : null)
  if (loadError)
    return (
      <ErrorState
        message={loadError}
        onRetry={() => {
          sessions.reload()
          balance.reload()
        }}
      />
    )

  return (
    <>
      <div className="chat-layout">
        {selected ? (
          <ChatPanel key={selected.session_id} accountId={accountId} session={selected} viewMode={mode} onNewSession={() => setOpenModal(true)} />
        ) : (
          <div className="card chat chat-empty">
            <EmptyState label="No session" title={balance.data ? 'Open a session to start chatting' : 'Deposit credits, then open a session'}>
              <p className="muted">
                A session locks a spending cap from your credits. You only pay for what you use; the rest comes back when it ends.
              </p>
              {balance.data ? (
                <button className="btn btn-primary" onClick={() => setOpenModal(true)}>
                  Open a {MODE_INFO[mode].short} session
                </button>
              ) : (
                <Link className="btn btn-primary" to="/app">
                  Go to deposit
                </Link>
              )}
            </EmptyState>
          </div>
        )}

        <aside className="chat-side">
          <section className="card">
            <div className="card-head">
              <span className="label">Session</span>
              <button className="chip" onClick={() => setOpenModal(true)} disabled={!balance.data || (balance.data?.open_sessions.length ?? 0) >= 4}>
                + New
              </button>
            </div>
            {sessions.data && sessions.data.length > 1 && (
              <select className="select" value={selected?.session_id} onChange={(e) => select(e.target.value)} aria-label="Choose session">
                {sessions.data.map((s) => (
                  <option key={s.session_id} value={s.session_id}>
                    #{s.session_id} · {MODE_INFO[s.mode].short} · {sessionPhase(s, now)}
                  </option>
                ))}
              </select>
            )}
            {selected ? <SessionCard s={selected} compact /> : <p className="muted small">No open session.</p>}
          </section>
          <ProofPanel accountId={accountId} session={selected} />
        </aside>
      </div>
      <OpenSessionModal
        open={openModal}
        onClose={() => setOpenModal(false)}
        balance={balance.data}
        defaultMode={mode}
        onOpened={(s) => select(s.session_id)}
      />
    </>
  )
}

function ChatPanel({
  accountId,
  session,
  viewMode,
  onNewSession,
}: {
  accountId: string
  session: SessionInfo
  viewMode: PrivacyMode
  onNewSession: () => void
}) {
  const client = useClient()
  const toast = useToast()
  const now = useNow()
  const [messages, setMessages] = useState<ChatMessage[] | null>(null)
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [notice, setNotice] = useState<{ code: string; text: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const phase = sessionPhase(session, now)
  const { config } = useNear()
  /** A transfer request waiting for the user's confirmation (Mode A). */
  const [pending, setPending] = useState<{ intent: TransferIntent; prompt: string; recipient: RecipientStatus | 'checking' } | null>(null)
  const [sending, setSending] = useState(false)

  /** Mode A: a clear "send X NEAR to Y" is handled here in the browser, never sent to the gateway. */
  function interceptTransfer(prompt: string): boolean {
    if (session.mode !== 'A') return false
    const parsed = parseTransfer(prompt)
    if (parsed.kind === 'none') return false
    if (parsed.kind === 'invalid' || parsed.intent.to === accountId) {
      setNotice({ code: 'TRANSFER', text: parsed.kind === 'invalid' ? `That looks like a transfer, but ${parsed.reason} Nothing was sent.` : 'That would send NEAR to your own account. Nothing was sent.' })
      return true
    }
    const { intent } = parsed
    setNotice(null)
    setPending({ intent, prompt, recipient: 'checking' })
    client
      .checkRecipient(intent.to)
      .catch((): RecipientStatus => 'unknown')
      .then((recipient) => setPending((cur) => (cur && cur.intent === intent ? { ...cur, recipient } : cur)))
    return true
  }

  async function confirmTransfer() {
    if (!pending || sending) return
    setSending(true)
    try {
      const added = await client.transferNear(accountId, session.session_id, pending.intent.to, pending.intent.yocto, pending.prompt)
      setMessages((m) => [...(m ?? []), ...added])
      setDraft('')
      setPending(null)
      toast.ok('Transfer sent', `${pending.intent.amount} NEAR to ${pending.intent.to}`)
    } catch (e) {
      toast.error('Transfer not sent', e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    client.getMessages(accountId, session.session_id).then((m) => !cancelled && setMessages(m))
    return () => {
      cancelled = true
      abort.current?.abort()
    }
  }, [client, accountId, session.session_id])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages])

  async function send(text: string) {
    const prompt = text.trim()
    if (!prompt || streaming) return
    if (interceptTransfer(prompt)) return
    setDraft('')
    setNotice(null)
    setStreaming(true)
    const ctrl = new AbortController()
    abort.current = ctrl
    const userMsg: ChatMessage = { id: `local-u-${Date.now()}`, role: 'user', content: prompt, at: Date.now() }
    const bot: ChatMessage = { id: `local-a-${Date.now()}`, role: 'assistant', content: '', at: Date.now() }
    setMessages((m) => [...(m ?? []), userMsg, bot])
    const patchBot = (fn: (b: ChatMessage) => ChatMessage) =>
      setMessages((m) => (m ? m.map((x) => (x.id === bot.id ? fn(x) : x)) : m))
    try {
      for await (const ev of client.chat(accountId, session.session_id, prompt, ctrl.signal)) {
        if (ev.type === 'token') patchBot((b) => ({ ...b, content: b.content + ev.text }))
        else if (ev.type === 'usage') patchBot((b) => ({ ...b, cost: ev.cost, tokens: ev.tokens }))
        else if (ev.type === 'error') {
          patchBot((b) => ({ ...b, error: ev.message }))
          setNotice({ code: ev.code, text: ev.message })
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      patchBot((b) => ({ ...b, error: msg }))
      toast.error('Message failed', msg)
    } finally {
      setStreaming(false)
      abort.current = null
    }
  }

  const disabled = phase !== 'active' || notice?.code === 'CAP_REACHED'
  const placeholder =
    phase !== 'active'
      ? 'This session has expired. End it to settle, or open a new one.'
      : notice?.code === 'CAP_REACHED'
        ? 'Spending cap reached. Open a new session to continue.'
        : session.mode === 'A'
          ? `Message Nexora, or try "send 0.001 NEAR to alice.${config.networkId === 'mainnet' ? 'near' : 'testnet'}"`
          : `Message Nexora (${MODE_INFO[session.mode].short} · ${MODE_INFO[session.mode].title.toLowerCase()})`

  return (
    <section className="card chat">
      <div className="chat-top">
        <span className="label">
          Session #{session.session_id} · {MODE_INFO[session.mode].short} · {MODE_INFO[session.mode].title}
        </span>
        {viewMode !== session.mode && <span className="small muted">Mode is fixed per session. Open a new one to use {MODE_INFO[viewMode].short}.</span>}
      </div>

      <div className="chat-log" ref={logRef} aria-live="polite">
        {messages === null ? (
          <Skeleton h={120} />
        ) : messages.length === 0 ? (
          <div className="chat-hello">
            <p className="muted">Start with one of these, or write your own.</p>
            <div className="chips">
              {['Summarize my medical report in plain words', 'Draft a seed term sheet', 'Review this liability clause', 'How are staking rewards taxed?'].map((p) => (
                <button key={p} className="chip" onClick={() => send(p)} disabled={disabled}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`bubble ${m.role === 'user' ? 'me' : ''} ${m.error ? 'has-error' : ''}`}>
              {m.role === 'assistant' && <span className="label muted">Nexora</span>}
              <div className="bubble-text">{m.content || (streaming && m.role === 'assistant' ? <span className="typing">●●●</span> : '')}</div>
              {m.action && m.role === 'assistant' && (
                <div className="bubble-meta">
                  <span>Wallet action · not sent to a model · no credits used</span>
                  {m.tx && (
                    <a href={`${config.explorerUrl}/txns/${m.tx}`} target="_blank" rel="noreferrer">
                      View transaction ↗
                    </a>
                  )}
                </div>
              )}
              {(m.cost || m.error) && (
                <div className="bubble-meta">
                  {m.cost && (
                    <span>
                      {m.tokens} tokens · <Near yocto={m.cost} decimals={5} />
                    </span>
                  )}
                  {m.error && <span className="error">{m.error}</span>}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {notice && (
        <div className={`chat-notice ${notice.code === 'GATEWAY_DOWN' ? 'warn' : ''}`} role="alert">
          <span>{notice.text}</span>
          {notice.code === 'CAP_REACHED' || notice.code === 'SESSION_EXPIRED' || notice.code === 'SESSION_CLOSED' ? (
            <button className="btn btn-sm-inline" onClick={onNewSession}>
              Open new session
            </button>
          ) : (
            <button className="btn btn-sm-inline" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          )}
        </div>
      )}

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          send(draft)
        }}
      >
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(draft)
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          aria-label="Message"
        />
        {streaming ? (
          <button type="button" className="btn" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" disabled={disabled || !draft.trim()}>
            Send
          </button>
        )}
      </form>

      <Modal
        open={!!pending}
        onClose={() => !sending && setPending(null)}
        busy={sending}
        label="Confirm transfer"
        title={pending ? `Send ${pending.intent.amount} NEAR` : 'Send NEAR'}
        footer={
          <>
            <span className="muted small">{sending ? 'Approve it in your wallet…' : 'Your wallet opens next. Nothing moves until you approve there.'}</span>
            <button className="btn btn-primary" onClick={confirmTransfer} disabled={sending || !pending || pending.recipient === 'checking' || pending.recipient === 'missing'}>
              {sending ? 'Waiting for wallet…' : 'Open wallet'}
            </button>
          </>
        }
      >
        {pending && (
          <>
            <ul className="kv kv-row small">
              <li>
                <span className="muted">Amount</span>
                <strong>
                  <Near yocto={pending.intent.yocto} decimals={24} />
                </strong>
              </li>
              <li>
                <span className="muted">To</span>
                <strong className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {pending.intent.to}
                </strong>
              </li>
              <li>
                <span className="muted">From</span>
                <span className="mono">{accountId}</span>
              </li>
              <li>
                <span className="muted">Network</span>
                <span>{config.label}</span>
              </li>
              <li>
                <span className="muted">Recipient</span>
                <span className={pending.recipient === 'missing' ? 'error' : ''}>
                  {pending.recipient === 'checking'
                    ? 'Checking…'
                    : pending.recipient === 'exists'
                      ? `Account exists on ${config.label.toLowerCase()}`
                      : pending.recipient === 'implicit'
                        ? 'Implicit account (created on first transfer)'
                        : pending.recipient === 'missing'
                          ? `No such account on ${config.label.toLowerCase()}`
                          : 'Could not check. Make sure the name is right.'}
                </span>
              </li>
            </ul>
            {pending.recipient === 'missing' && (
              <p className="small error">
                {pending.intent.to} does not exist on {config.label.toLowerCase()}, so this transfer would fail.
                {config.networkId === 'testnet' && pending.intent.to.endsWith('.near') ? ' Names ending in .near are mainnet accounts; on testnet they end in .testnet.' : ''}
              </p>
            )}
            <p className="callout small">
              <strong>This transfer is public.</strong> It goes from your account to the recipient on-chain, signed by your wallet. Your request was read in this browser only: it was not sent to the gateway or a model and uses no credits. Transfers cannot be undone.
            </p>
          </>
        )}
      </Modal>
    </section>
  )
}

function ProofPanel({ accountId, session }: { accountId: string; session: SessionInfo | undefined }) {
  const proof = useClientQuery<Proof | null>((c) => (session ? c.getProof(accountId, session.session_id) : Promise.resolve(null)), [accountId, session?.session_id])
  const mode = session?.mode ?? 'B'
  const p = proof.data

  return (
    <section className="card proof">
      <div className="card-head">
        <span className="label">{mode === 'B' ? 'TEE attestation' : 'Payment proof'}</span>
        {p ? <span className={`badge ${p.verified ? 'badge-ok' : 'badge-warn'}`}>{p.verified ? 'Verified' : 'Not verified'}{p.raw?.mock ? ' · mock' : ''}</span> : <span className="badge badge-dim">Waiting</span>}
      </div>
      {!session ? (
        <p className="muted small">Open a session to see where your prompt runs and how it was paid for.</p>
      ) : proof.loading ? (
        <Skeleton h={120} />
      ) : !p ? (
        <p className="muted small">
          {mode === 'B'
            ? 'After the first answer, this shows the attestation proving the model ran inside a TEE on NEAR AI Cloud.'
            : 'After the first answer, this shows the zero-knowledge proof that paid for it without revealing your account.'}
        </p>
      ) : p.kind === 'tee' ? (
        <>
          <ul className="kv small">
            <li>
              <span className="muted">Provider · model</span>
              <span>
                {p.provider} · <span className="mono">{p.model}</span>
              </span>
            </li>
            <li>
              <span className="muted">Hardware</span>
              <span>{p.hardware}</span>
            </li>
            <li>
              <span className="muted">Measurement</span>
              <span className="row" style={{ gap: 6 }}>
                <span className="mono">{shortHash(p.measurement, 10)}</span> <CopyButton text={p.measurement} />
              </span>
            </li>
            <li>
              <span className="muted">Signing key</span>
              <span className="mono">{shortHash(p.signing_key, 8)}</span>
            </li>
            <li>
              <span className="muted">Nonce · issued</span>
              <span>
                <span className="mono">{shortHash(p.nonce, 6)}</span> · {formatTime(p.issued_at)}
              </span>
            </li>
          </ul>
          {p.checks && p.checks.length > 0 && (
            <ul className="checks small">
              {p.checks.map((c) => (
                <li key={c.name} title={c.detail}>
                  <span className={c.ok ? 'check-ok' : 'check-fail'} aria-label={c.ok ? 'passed' : 'failed'}>
                    {c.ok ? '✓' : '✕'}
                  </span>
                  <span>
                    {c.name}
                    <span className="muted"> · {c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <details className="raw">
            <summary className="small">Raw attestation</summary>
            <pre>{JSON.stringify(p, null, 2)}</pre>
          </details>
          <a className="small" href={p.verify_url} target="_blank" rel="noreferrer">
            How to verify independently ↗
          </a>
        </>
      ) : (
        <>
          <ul className="kv small">
            <li>
              <span className="muted">Scheme</span>
              <span>{p.scheme}</span>
            </li>
            <li>
              <span className="muted">Nullifier</span>
              <span className="row" style={{ gap: 6 }}>
                <span className="mono">{shortHash(p.nullifier, 10)}</span> <CopyButton text={p.nullifier} />
              </span>
            </li>
            <li>
              <span className="muted">Proof size</span>
              <span>{p.proof_bytes} bytes</span>
            </li>
            <li>
              <span className="muted">Key reuse window</span>
              <span>{p.key_reuse_window_s}s · a fresh key for every request</span>
            </li>
          </ul>
          {p.verified ? (
            <p className="small muted">The provider sees that a valid credit paid for this request, not which account it came from. Your IP address and prompt are not hidden in this mode.</p>
          ) : (
            <p className="callout small">
              <strong>Payer not hidden yet.</strong> {typeof p.raw?.note === 'string' ? p.raw.note : 'No zero-knowledge proof was produced for this request.'}
            </p>
          )}
          <details className="raw">
            <summary className="small">Raw proof</summary>
            <pre>{JSON.stringify(p, null, 2)}</pre>
          </details>
        </>
      )}
      {session && (
        <p className="small muted" style={{ marginTop: 10 }}>
          Spent so far: <Near yocto={session.metered} decimals={5} />
        </p>
      )}
    </section>
  )
}

/** Live mode: be explicit about what is real (credits, metering, settlement) and what is not yet (model replies). */
function LiveNotice() {
  const client = useClient()
  const health = useClientQuery<GatewayHealth>(() => fetchGatewayHealth(), [])
  if (client.kind !== 'live') return null
  const h = health.data
  return (
    <p className="callout small" style={{ marginBottom: 14 }}>
      <strong>Live.</strong> Sessions, metering and settlement are real transactions on the credits contract, through the gateway at{' '}
      <code>{GATEWAY_URL}</code>.{' '}
      {health.error
        ? 'The gateway is not reachable right now.'
        : !h
          ? ''
          : h.model_live
            ? `Mode B replies come from ${h.model} inside a TEE on NEAR AI Cloud; the gateway verifies the attestation before sending your prompt.`
            : `Mode B attestation of ${h.attested_model ?? 'the model'} is real, but replies are simulated: the gateway has no NEAR AI Cloud API key.`}{' '}
      Mode A (zkAPI) is a preview: payment is still linked to your account.
    </p>
  )
}
