import type { ModuleState, WalletSelector } from '@near-wallet-selector/core'
import { createContext, useContext } from 'react'
import type { NetworkConfig, NetworkId } from '../config/networks'

export interface NearContextValue {
  networkId: NetworkId
  config: NetworkConfig
  setNetwork: (id: NetworkId) => void
  status: 'loading' | 'ready' | 'error'
  error: string | null
  selector: WalletSelector | null
  modules: ModuleState[]
  accountId: string | null
  /** True when using the mock-only demo identity instead of a wallet. */
  isDemo: boolean
  enterDemo: () => void
  selectedWalletId: string | null
  signIn: (walletId: string) => Promise<void>
  signOut: () => Promise<void>
  modalOpen: boolean
  openModal: () => void
  closeModal: () => void
}

export const NearContext = createContext<NearContextValue | null>(null)

export function useNear() {
  const ctx = useContext(NearContext)
  if (!ctx) throw new Error('useNear must be used inside <NearProvider>')
  return ctx
}
