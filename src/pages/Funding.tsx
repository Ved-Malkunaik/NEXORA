import { PageHeader } from '../components/Layouts'
import { useNear } from '../wallet/context'

export function Funding() {
  const { config, setNetwork } = useNear()
  return (
    <>
      <PageHeader label="03 · Funding" title="Top up with NEAR Intents" subtitle="Fund your private balance from NEAR or stablecoins." />
      {config.intentsSupported ? (
        <section className="card">
          <div className="card-head">
            <span className="label">Intents</span>
            <span className="badge badge-ok">Mainnet</span>
          </div>
          <h3>Swap and deposit in one step</h3>
          <p className="muted small">
            Pick an asset and an amount. We fetch a dry-run quote first, so you see the rate before anything is signed.
          </p>
          <div className="row">
            <button className="btn btn-primary" disabled title="Arrives with the Intents integration">
              Get a quote
            </button>
          </div>
        </section>
      ) : (
        <section className="card empty">
          <span className="label">Mainnet only</span>
          <h3 style={{ marginTop: 10 }}>NEAR Intents has no testnet</h3>
          <p className="muted">
            On testnet, deposit NEAR directly from the dashboard. Switch to mainnet to fund with other assets through
            Intents.
          </p>
          <button className="btn" onClick={() => setNetwork('mainnet')}>
            Switch to mainnet
          </button>
        </section>
      )}
    </>
  )
}
