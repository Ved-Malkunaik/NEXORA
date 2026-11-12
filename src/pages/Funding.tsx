import { useEffect, useState } from 'react'
import { useClient, useClientQuery } from '../client/context'
import type { IntentsQuote } from '../client/types'
import { DepositModal } from '../components/actions'
import { PageHeader, RequireWallet } from '../components/Layouts'
import { useToast } from '../components/toast'
import { MockBadge, Modal, Near, formatDuration } from '../components/ui'
import { formatNear } from '../lib/near-amount'
import { useNear } from '../wallet/context'

export function Funding() {
  const { config, setNetwork, accountId } = useNear()
  return (
    <>
      <PageHeader label="03 · Funding" title="Top up with NEAR Intents" subtitle="Fund your private balance from NEAR or stablecoins on other chains.">
        <MockBadge />
      </PageHeader>
      {!config.intentsSupported && (
        <section className="card notice-card">
          <div>
            <span className="label">Mainnet only</span>
            <h3 style={{ marginTop: 6 }}>NEAR Intents has no testnet</h3>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              On testnet, deposit NEAR directly. The form below previews the mainnet flow with dry-run quotes; funding is disabled.
            </p>
          </div>
          <div className="row">
            <TestnetDeposit />
            <button className="btn" onClick={() => setNetwork('mainnet')}>
              Switch to mainnet
            </button>
          </div>
        </section>
      )}
      <RequireWallet what="fund your balance">{accountId && <IntentsForm accountId={accountId} live={config.intentsSupported} />}</RequireWallet>
    </>
  )
}

function TestnetDeposit() {
  const { accountId } = useNear()
  const balance = useClientQuery((c) => (accountId ? c.getBalance(accountId) : Promise.resolve(null)), [accountId])
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="btn btn-primary" onClick={() => setOpen(true)} disabled={!accountId}>
        Deposit NEAR
      </button>
      <DepositModal open={open} onClose={() => setOpen(false)} balance={balance.data} />
    </>
  )
}

function IntentsForm({ accountId, live }: { accountId: string; live: boolean }) {
  const client = useClient()
  const toast = useToast()
  const assets = client.getAssets()
  const [assetId, setAssetId] = useState(assets[1]?.id ?? assets[0].id)
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState<IntentsQuote | null>(null)
  const [busy, setBusy] = useState<'quote' | 'fund' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const asset = assets.find((a) => a.id === assetId)!

  useEffect(() => {
    if (!quote) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [quote])

  useEffect(() => {
    setQuote(null)
    setError(null)
  }, [assetId, amount])

  const expired = quote ? now > quote.expires_at : false
  const amountErr = amount && (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) ? 'Enter an amount greater than 0' : null

  async function getQuote() {
    setBusy('quote')
    setError(null)
    try {
      const q = await client.getQuote(assetId, amount)
      setQuote(q)
      setNow(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function fund() {
    if (!quote) return
    setBusy('fund')
    try {
      const b = await client.fundWithQuote(accountId, quote.quote_id)
      toast.ok('Funds arrived', `${quote.amount_in} ${asset.symbol} became credits. ${formatNear(b.available)} NEAR available.`)
      setQuote(null)
      setAmount('')
      setConfirm(false)
    } catch (e) {
      toast.error('Funding failed', e instanceof Error ? e.message : String(e))
      setConfirm(false)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid-2 funding">
      <section className="card">
        <span className="label">1 · What you send</span>
        <div className="field" style={{ marginTop: 12 }}>
          <label className="label" htmlFor="asset">
            Asset
          </label>
          <div className="asset-pick" id="asset" role="radiogroup">
            {assets.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={a.id === assetId} className={`chip ${a.id === assetId ? 'on' : ''}`} onClick={() => setAssetId(a.id)}>
                {a.symbol} <span className="muted">· {a.chain}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="amt">
            Amount
          </label>
          <div className={`amount-input ${amountErr ? 'invalid' : ''}`}>
            <input id="amt" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} />
            <span className="unit">{asset.symbol}</span>
          </div>
          <p className={`small ${amountErr || error ? 'error' : 'muted'}`}>{amountErr || error || `Sent from ${asset.chain}. Arrives as NEAR credits.`}</p>
        </div>
        <button className="btn btn-primary" onClick={getQuote} disabled={!amount || !!amountErr || busy !== null}>
          {busy === 'quote' ? 'Getting quote…' : quote ? 'Refresh quote' : 'Get quote'}
        </button>
      </section>

      <section className="card">
        <span className="label">2 · What arrives</span>
        {!quote ? (
          <div className="quote-empty">
            <p className="muted small">Pick an asset and amount, then get a dry-run quote. Nothing is signed until you confirm.</p>
          </div>
        ) : (
          <>
            <div className="quote-big">
              <Near yocto={quote.amount_out} />
              <span className="muted small">as credits</span>
            </div>
            {quote.source === '1click' && (
              <p className="small muted">Priced by NEAR Intents solvers right now. The swap delivers wNEAR to your NEAR Intents balance; unwrapping it and depositing it as credits is a second step.</p>
            )}
            <ul className="kv kv-row small">
              <li>
                <span className="muted">You send</span>
                <span>
                  {quote.amount_in} {asset.symbol} on {asset.chain}
                </span>
              </li>
              <li>
                <span className="muted">Rate</span>
                <span>{quote.rate}</span>
              </li>
              <li>
                <span className="muted">Solver fee</span>
                <span>
                  <Near yocto={quote.fee} decimals={5} />
                </span>
              </li>
              <li>
                <span className="muted">Quote</span>
                <span className={expired ? 'error' : ''}>{expired ? 'Expired' : `Valid ${formatDuration(quote.expires_at - now)}`} · dry run · {quote.source === '1click' ? 'live 1Click price' : quote.source === 'direct' ? 'no swap' : 'mock rate'}</span>
              </li>
            </ul>
            <div className="row" style={{ marginTop: 14 }}>
              {expired ? (
                <button className="btn btn-primary" onClick={getQuote} disabled={busy !== null}>
                  Get a fresh quote
                </button>
              ) : (
                <button className="btn btn-primary" onClick={() => setConfirm(true)} disabled={!live || busy !== null} title={live ? '' : 'Mainnet only'}>
                  {live ? 'Fund my balance' : 'Funding is mainnet only'}
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        busy={busy === 'fund'}
        label="Confirm"
        title="Fund with NEAR Intents"
        footer={
          <>
            <span className="muted small">Your wallet asks you to sign the intent.</span>
            <button className="btn btn-primary" onClick={fund} disabled={busy === 'fund' || expired}>
              {busy === 'fund' ? 'Waiting for settlement…' : 'Confirm and sign'}
            </button>
          </>
        }
      >
        {quote && (
          <p>
            Send <strong>{quote.amount_in} {asset.symbol}</strong> on {asset.chain} and receive <strong><Near yocto={quote.amount_out} /></strong> as Nexora credits.
          </p>
        )}
        <p className="callout small">The deposit is public on-chain. Mode A and Mode B protect your chats, not this funding transaction.</p>
      </Modal>
    </div>
  )
}
