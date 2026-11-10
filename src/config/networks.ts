/**
 * Single source of truth for everything that differs between mainnet and testnet.
 * Switching networks swaps this config and re-initialises the wallet selector
 * (see src/wallet/NearProvider.tsx) — no page reload.
 */
export type NetworkId = 'testnet' | 'mainnet'

export interface NetworkConfig {
  networkId: NetworkId
  label: string
  /** Primary RPC endpoint. */
  nodeUrl: string
  /** Extra RPC endpoints the wallet selector falls back to. */
  fallbackRpcUrls: string[]
  helperUrl: string
  explorerUrl: string
  indexerUrl: string
  /** Credits-ledger contract (Level 1). The session key is scoped to this account. */
  contractId: string
  /** NEAR Intents has no testnet, so funding via Intents is mainnet only. */
  intentsSupported: boolean
}

const env = import.meta.env

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  testnet: {
    networkId: 'testnet',
    label: 'Testnet',
    nodeUrl: env.VITE_TESTNET_RPC_URL || 'https://rpc.testnet.fastnear.com',
    fallbackRpcUrls: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
    helperUrl: 'https://helper.testnet.near.org',
    explorerUrl: 'https://testnet.nearblocks.io',
    indexerUrl: 'https://testnet-api.kitwallet.app',
    contractId: env.VITE_TESTNET_CONTRACT_ID || 'nexora-credits.testnet',
    intentsSupported: false,
  },
  mainnet: {
    networkId: 'mainnet',
    label: 'Mainnet',
    nodeUrl: env.VITE_MAINNET_RPC_URL || 'https://rpc.mainnet.fastnear.com',
    fallbackRpcUrls: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
    helperUrl: 'https://helper.mainnet.near.org',
    explorerUrl: 'https://nearblocks.io',
    indexerUrl: 'https://api.kitwallet.app',
    contractId: env.VITE_MAINNET_CONTRACT_ID || 'nexora-credits.near',
    intentsSupported: true,
  },
}

/**
 * Methods the limited function-call access key ("session key") may call without a
 * wallet popup. Payable methods (`deposit`, and `withdraw` which needs 1 yoctoNEAR)
 * are intentionally excluded: function-call keys cannot attach deposits, so those
 * always go through the wallet.
 */
export const SESSION_KEY_METHODS = ['open_session', 'reclaim_session']

const DEFAULT_NETWORK: NetworkId = env.VITE_DEFAULT_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
const NETWORK_STORAGE_KEY = 'nexora:network'

export function loadNetworkId(): NetworkId {
  try {
    const v = localStorage.getItem(NETWORK_STORAGE_KEY)
    if (v === 'testnet' || v === 'mainnet') return v
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_NETWORK
}

export function saveNetworkId(id: NetworkId) {
  try {
    localStorage.setItem(NETWORK_STORAGE_KEY, id)
  } catch {
    /* storage unavailable */
  }
}
