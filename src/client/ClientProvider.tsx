import { useMemo, type ReactNode } from 'react'
import { useNear } from '../wallet/context'
import { ClientContext } from './context'
import { LiveClient } from './live'
import { MockClient } from './mock'

/**
 * Wallet connected -> LiveClient: real contract reads and transactions, gateway for chat + settle.
 * Demo account or no wallet -> MockClient: everything simulated, nothing on-chain.
 */
export function ClientProvider({ children }: { children: ReactNode }) {
  const { networkId, config, selector, accountId, isDemo } = useNear()
  const live = !!selector && !!accountId && !isDemo
  const client = useMemo(
    () => (live && selector ? new LiveClient(config, selector) : new MockClient(networkId)),
    [live, selector, config, networkId],
  )
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
}
