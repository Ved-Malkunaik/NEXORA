import {
  setupWalletSelector,
  type AccountState,
  type ModuleState,
  type StorageService,
  type WalletSelector,
} from '@near-wallet-selector/core'
import { setupHereWallet } from '@near-wallet-selector/here-wallet'
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet'
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet'
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  NETWORKS,
  SESSION_KEY_METHODS,
  loadNetworkId,
  saveNetworkId,
  type NetworkConfig,
  type NetworkId,
} from '../config/networks'
import { NearContext, type NearContextValue } from './context'

/**
 * Wallet-selector state lives in storage. Namespacing it per network keeps a
 * testnet login from leaking into mainnet (and vice versa) when the user switches.
 */
function networkStorage(networkId: NetworkId): StorageService {
  const prefix = `nexora:${networkId}:`
  return {
    async getItem(key) {
      try {
        return localStorage.getItem(prefix + key)
      } catch {
        return null
      }
    },
    async setItem(key, value) {
      try {
        localStorage.setItem(prefix + key, value)
      } catch {
        /* storage unavailable */
      }
    },
    async removeItem(key) {
      try {
        localStorage.removeItem(prefix + key)
      } catch {
        /* storage unavailable */
      }
    },
  }
}

function createSelector(cfg: NetworkConfig) {
  return setupWalletSelector({
    network: {
      networkId: cfg.networkId,
      nodeUrl: cfg.nodeUrl,
      helperUrl: cfg.helperUrl,
      explorerUrl: cfg.explorerUrl,
      indexerUrl: cfg.indexerUrl,
    },
    fallbackRpcUrls: [cfg.nodeUrl, ...cfg.fallbackRpcUrls],
    storage: networkStorage(cfg.networkId),
    // Required so a network switch builds a fresh selector instead of returning the cached singleton.
    allowMultipleSelectors: true,
    // Account abstraction: every sign-in adds a function-call access key limited to our contract.
    createAccessKeyFor: { contractId: cfg.contractId, methodNames: SESSION_KEY_METHODS },
    modules: [setupMyNearWallet(), setupMeteorWallet(), setupHereWallet(), setupIntearWallet()],
  })
}

export function NearProvider({ children }: { children: ReactNode }) {
  const [networkId, setNetworkIdState] = useState<NetworkId>(loadNetworkId)
  const [selector, setSelector] = useState<WalletSelector | null>(null)
  const [modules, setModules] = useState<ModuleState[]>([])
  const [accounts, setAccounts] = useState<AccountState[]>([])
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null)
  const [status, setStatus] = useState<NearContextValue['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  const config = NETWORKS[networkId]

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined

    setStatus('loading')
    setError(null)
    setSelector(null)
    setAccounts([])
    setModules([])
    setSelectedWalletId(null)

    createSelector(NETWORKS[networkId])
      .then((sel) => {
        if (cancelled) return
        const sync = (s: ReturnType<typeof sel.store.getState>) => {
          setModules(s.modules)
          setAccounts(s.accounts)
          setSelectedWalletId(s.selectedWalletId)
        }
        sync(sel.store.getState())
        const sub = sel.store.observable.subscribe(sync)
        unsubscribe = () => sub.unsubscribe()
        setSelector(sel)
        setStatus('ready')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      })

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [networkId])

  const setNetwork = useCallback((id: NetworkId) => {
    saveNetworkId(id)
    setModalOpen(false)
    setNetworkIdState(id)
  }, [])

  const signIn = useCallback(
    async (walletId: string) => {
      if (!selector) throw new Error('Wallet selector not ready')
      const wallet = await selector.wallet(walletId)
      // contractId/methodNames are merged in from `createAccessKeyFor`.
      await (wallet.signIn as (p: object) => Promise<unknown>)({})
      setModalOpen(false)
    },
    [selector],
  )

  const signOut = useCallback(async () => {
    if (!selector || !selector.isSignedIn()) return
    const wallet = await selector.wallet()
    await wallet.signOut()
  }, [selector])

  const value = useMemo<NearContextValue>(() => {
    const active = accounts.find((a) => a.active) ?? accounts[0]
    return {
      networkId,
      config,
      setNetwork,
      status,
      error,
      selector,
      modules,
      accountId: active?.accountId ?? null,
      selectedWalletId,
      signIn,
      signOut,
      modalOpen,
      openModal: () => setModalOpen(true),
      closeModal: () => setModalOpen(false),
    }
  }, [networkId, config, setNetwork, status, error, selector, modules, accounts, selectedWalletId, signIn, signOut, modalOpen])

  return <NearContext.Provider value={value}>{children}</NearContext.Provider>
}
