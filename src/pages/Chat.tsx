import { useState } from 'react'
import { PageHeader } from '../components/Layouts'

type Mode = 'A' | 'B'

const MODES: Record<Mode, { title: string; body: string }> = {
  A: { title: 'Mode A · Hide who pays', body: 'Requests are paid with zkAPI credits, so the provider cannot link them to your account.' },
  B: { title: 'Mode B · Hide what you ask', body: 'Prompts run inside a TEE on NEAR AI Cloud. Each answer carries an attestation.' },
}

export function Chat() {
  const [mode, setMode] = useState<Mode>('B')
  return (
    <>
      <PageHeader label="02 · Chat" title="Private chat" subtitle={MODES[mode].body}>
        <div className="segmented" role="radiogroup" aria-label="Privacy mode">
          {(['A', 'B'] as Mode[]).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
              {MODES[m].title.split(' · ')[0]}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="grid-2" style={{ gridTemplateColumns: '2fr 1fr' }}>
        <section className="card chat">
          <div className="chat-log">
            <div className="bubble">
              <span className="label muted">Nexora</span>
              <div>Hi. Pick a privacy mode and open a capped session to start chatting.</div>
            </div>
          </div>
          <form className="chat-input" onSubmit={(e) => e.preventDefault()}>
            <input placeholder="Chat opens once a session is funded" disabled aria-label="Message" />
            <button className="btn btn-primary" disabled>
              Send
            </button>
          </form>
        </section>
        <section className="card">
          <span className="label">Attestation</span>
          <h3 style={{ marginTop: 6 }}>{mode === 'B' ? 'TEE proof' : 'Payment proof'}</h3>
          <p className="muted small">
            {mode === 'B'
              ? 'After your first answer, the enclave attestation from NEAR AI Cloud shows here, ready to verify.'
              : 'After your first request, the zero-knowledge payment receipt shows here.'}
          </p>
          <ul className="kv kv-row small">
            <li>
              <span className="muted">Session</span>
              <span>None open</span>
            </li>
            <li>
              <span className="muted">Cap</span>
              <span>—</span>
            </li>
            <li>
              <span className="muted">Spent</span>
              <span>—</span>
            </li>
          </ul>
        </section>
      </div>
    </>
  )
}
