import type { ReactNode } from 'react'
import { Outlet } from 'react-router-dom'
import { useMockControls } from '../client/context'
import { useNear } from '../wallet/context'
import { MobileTabs, Navbar } from './Navbar'
import { WalletModal } from './WalletModal'

export function Guides() {
  return (
    <div className="guides" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  )
}

function NetworkBanner() {
  const { networkId, status, error, isDemo } = useNear()
  if (isDemo) return <div className="banner banner-demo">Demo account · everything here is simulated, nothing touches the chain</div>
  if (status === 'error') return <div className="banner banner-error">Wallet selector failed to load: {error}</div>
  if (networkId === 'mainnet') return <div className="banner banner-mainnet">Mainnet: transactions use real NEAR</div>
  return null
}

export function AppLayout() {
  return (
    <>
      <Navbar lifted />
      <MobileTabs />
      <NetworkBanner />
      <main className="app-main">
        <Outlet />
      </main>
      <WalletModal />
    </>
  )
}

/** Renders children only when a wallet is connected; otherwise a connect prompt. */
export function RequireWallet({ children, what }: { children: ReactNode; what: string }) {
  const { accountId, openModal, status, enterDemo } = useNear()
  const mock = useMockControls()
  if (accountId) return <>{children}</>
  return (
    <div className="card empty">
      <span className="label">Not connected</span>
      <h3 style={{ marginTop: 10 }}>Connect a wallet to {what}</h3>
      <p className="muted">Sign in with a NEAR account. Nothing is sent on-chain until you approve it.</p>
      <div className="row">
        <button className="btn btn-primary" onClick={openModal} disabled={status !== 'ready'}>
        •• Connect wallet
      </button>
        {mock && (
          <button className="btn" onClick={enterDemo}>
            Explore with a demo account
          </button>
        )}
      </div>
      {mock && <p className="small muted" style={{ marginTop: 12 }}>The demo uses simulated credits, chats and proofs. No wallet needed, nothing on-chain.</p>}
    </div>
  )
}

export function PageHeader({ label, title, subtitle, children }: { label: string; title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <span className="label">{label}</span>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}
