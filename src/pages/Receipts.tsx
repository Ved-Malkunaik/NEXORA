import { useMemo, useState } from 'react'
import { useClientQuery } from '../client/context'
import type { Receipt } from '../client/types'
import { PageHeader, RequireWallet } from '../components/Layouts'
import { CopyButton, EmptyState, ErrorState, MockBadge, Near, Skeleton, formatTime, nsToMs, shortHash } from '../components/ui'
import { formatNear } from '../lib/near-amount'
import { useNear } from '../wallet/context'

type Filter = 'all' | 'Settled' | 'Reclaimed'

export function Receipts() {
  const { accountId } = useNear()
  return (
    <>
      <PageHeader
        label="04 · Receipts"
        title="Session receipts"
        subtitle="Each closed session leaves a receipt. Settled ones store a hash of the usage record; chat content is never stored."
      >
        <MockBadge />
      </PageHeader>
      <RequireWallet what="see your receipts">{accountId && <ReceiptsBody accountId={accountId} />}</RequireWallet>
    </>
  )
}

function toCsv(rows: Receipt[]): string {
  const head = 'session_id,outcome,cap_near,spent_near,refunded_near,closed_at,receipt_hash'
  const body = rows.map((r) =>
    [r.session_id, r.outcome, formatNear(r.cap, 24), formatNear(r.spent, 24), formatNear(r.refunded, 24), new Date(nsToMs(r.closed_at)).toISOString(), r.receipt_hash ?? '']
      .map((v) => `"${String(v).replace(/,/g, '')}"`)
      .join(','),
  )
  return [head, ...body].join('\n')
}

function ReceiptsBody({ accountId }: { accountId: string }) {
  const { config } = useNear()
  const q = useClientQuery((c) => c.getReceipts(accountId), [accountId])
  const [filter, setFilter] = useState<Filter>('all')
  const all = useMemo(() => [...(q.data ?? [])].reverse(), [q.data])
  const rows = filter === 'all' ? all : all.filter((r) => r.outcome === filter)
  const totals = useMemo(
    () => rows.reduce((t, r) => ({ spent: t.spent + BigInt(r.spent), refunded: t.refunded + BigInt(r.refunded) }), { spent: 0n, refunded: 0n }),
    [rows],
  )

  function exportCsv() {
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `nexora-receipts-${accountId}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (q.loading)
    return (
      <div className="card">
        <Skeleton h={160} />
      </div>
    )
  if (q.error) return <ErrorState message={q.error} onRetry={q.reload} />
  if (all.length === 0)
    return (
      <EmptyState label="No receipts yet" title="Nothing settled so far">
        <p className="muted">When a session closes, its cost, refund and receipt hash appear here. The contract keeps your last 20.</p>
      </EmptyState>
    )

  return (
    <>
      <div className="grid-3">
        <section className="card stat">
          <span className="label">Sessions closed</span>
          <strong className="stat-value">{rows.length}</strong>
        </section>
        <section className="card stat">
          <span className="label">Total spent</span>
          <strong className="stat-value">
            <Near yocto={totals.spent} />
          </strong>
        </section>
        <section className="card stat">
          <span className="label">Total refunded</span>
          <strong className="stat-value">
            <Near yocto={totals.refunded} />
          </strong>
        </section>
      </div>

      <div className="section-head">
        <div className="chips" role="radiogroup" aria-label="Filter receipts">
          {(['all', 'Settled', 'Reclaimed'] as Filter[]).map((f) => (
            <button key={f} role="radio" aria-checked={filter === f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f}
            </button>
          ))}
        </div>
        <button className="btn" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>

      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Outcome</th>
              <th className="num">Cap</th>
              <th className="num">Spent</th>
              <th className="num">Refunded</th>
              <th>Closed</th>
              <th>Receipt hash</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.session_id}>
                <td>#{r.session_id}</td>
                <td>
                  <span className={`badge ${r.outcome === 'Settled' ? 'badge-ok' : 'badge-warn'}`}>{r.outcome}</span>
                </td>
                <td className="num">
                  <Near yocto={r.cap} />
                </td>
                <td className="num">
                  <Near yocto={r.spent} decimals={5} />
                </td>
                <td className="num">
                  <Near yocto={r.refunded} decimals={5} />
                </td>
                <td className="muted">{formatTime(nsToMs(r.closed_at))}</td>
                <td>
                  {r.receipt_hash ? (
                    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <span className="mono">{shortHash(r.receipt_hash, 6)}</span>
                      <CopyButton text={r.receipt_hash} />
                    </span>
                  ) : (
                    <span className="muted">— reclaimed</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No {filter.toLowerCase()} receipts.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Receipts live in the contract <code>{config.contractId}</code>. The hash commits to the gateway's usage record (tokens, cost, time) without revealing any chat content.
      </p>
    </>
  )
}
