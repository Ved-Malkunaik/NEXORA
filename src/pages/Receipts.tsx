import { PageHeader, RequireWallet } from '../components/Layouts'

export function Receipts() {
  return (
    <>
      <PageHeader
        label="04 · Receipts"
        title="Session receipts"
        subtitle="Each settled session records a receipt hash on-chain. The content of your chats is never stored."
      />
      <RequireWallet what="see your receipts">
        <section className="card empty">
          <span className="label">No receipts yet</span>
          <h3 style={{ marginTop: 10 }}>Nothing settled so far</h3>
          <p className="muted">When a session closes, its cost, refund and receipt hash appear here.</p>
        </section>
      </RequireWallet>
    </>
  )
}
