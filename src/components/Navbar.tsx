import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useNear } from '../wallet/context'

export const APP_LINKS = [
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/chat', label: 'Chat' },
  { to: '/app/funding', label: 'Funding' },
  { to: '/app/receipts', label: 'Receipts' },
  { to: '/app/settings', label: 'Settings' },
]

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Nexora home">
      <svg width="27" height="27" viewBox="0 0 27 27" aria-hidden="true">
        <defs>
          <linearGradient id="logo-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff8a3d" />
            <stop offset="1" stopColor="#ff3d8b" />
          </linearGradient>
        </defs>
        <path d="M22 4.5H9.5a5 5 0 0 0-5 5v8a5 5 0 0 0 5 5H22" fill="none" stroke="url(#logo-grad)" strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="11.5" cy="13.5" r="1.7" fill="#141414" />
        <circle cx="17" cy="13.5" r="1.7" fill="#141414" />
      </svg>
      <span>NEXORA</span>
    </Link>
  )
}

function shorten(id: string) {
  return id.length > 18 ? `${id.slice(0, 7)}…${id.slice(-7)}` : id
}

/** The outlined "•• LAUNCH"-style button: connect wallet, or the account menu once connected. */
export function WalletButton() {
  const { accountId, openModal, signOut, status } = useNear()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (!accountId) {
    return (
      <button className="launch" onClick={openModal} disabled={status !== 'ready'}>
        <span className="launch-dots">••</span> {status === 'loading' ? 'LOADING' : 'CONNECT WALLET'}
      </button>
    )
  }
  return (
    <div className="account-menu" ref={ref}>
      <button className="launch" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={accountId}>
        <span className="launch-dots live">••</span> {shorten(accountId).toUpperCase()}
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => (setOpen(false), navigate('/app'))}>
            Dashboard
          </button>
          <button
            role="menuitem"
            onClick={async () => {
              setOpen(false)
              await signOut()
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  )
}

/** Pad cell: flips between testnet and mainnet (re-initialises the wallet selector, no reload). */
export function NetworkPad() {
  const { networkId, setNetwork, status } = useNear()
  const other = networkId === 'testnet' ? 'mainnet' : 'testnet'
  return (
    <button
      className={`pad net-${networkId}`}
      onClick={() => setNetwork(other)}
      disabled={status === 'loading'}
      title={`Switch to ${other}`}
    >
      <span className="pad-dot" /> {networkId === 'testnet' ? 'Testnet' : 'Mainnet'} ⇄
    </button>
  )
}

export function Navbar({ lifted }: { lifted: boolean }) {
  return (
    <header className={`nav ${lifted ? 'lifted' : ''}`}>
      <div className="nav-cell nav-logo">
        <Logo />
      </div>
      <nav className="nav-cell nav-menu" aria-label="Main">
        {APP_LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end}>
            {l.label}
          </NavLink>
        ))}
      </nav>
      <div className="nav-cell nav-pad">
        <NetworkPad />
      </div>
      <div className="nav-cell nav-btn">
        <WalletButton />
      </div>
    </header>
  )
}

/** Mobile-only strip of app links (the main menu is hidden under 900px). */
export function MobileTabs() {
  return (
    <nav className="mobile-tabs" aria-label="App sections">
      {APP_LINKS.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end}>
          {l.label}
        </NavLink>
      ))}
    </nav>
  )
}
