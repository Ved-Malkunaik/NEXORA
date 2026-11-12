import { useMemo, type ReactNode } from 'react'
import { useNear } from '../wallet/context'
import { ClientContext } from './context'
import { MockClient } from './mock'

/**
 * Provides the NexoraClient for the current network. Level 2: always the mock.
 * Level 3 replaces the factory below with the live client; screens don't change.
 */
export function ClientProvider({ children }: { children: ReactNode }) {
  const { networkId } = useNear()
  const client = useMemo(() => new MockClient(networkId), [networkId])
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
}
