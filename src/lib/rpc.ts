import type { NetworkConfig } from '../config/networks'

async function query<T>(cfg: NetworkConfig, params: Record<string, unknown>): Promise<T> {
  const urls = [cfg.nodeUrl, ...cfg.fallbackRpcUrls]
  let lastErr: unknown
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'nexora', method: 'query', params }),
      })
      if (!res.ok) throw new Error(`RPC ${res.status}`)
      const json = await res.json()
      if (json.error) throw new Error(json.error.data ?? json.error.message ?? 'RPC error')
      if (json.result?.error) throw new Error(json.result.error)
      return json.result as T
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('RPC unavailable')
}

export interface AccountView {
  amount: string
  locked: string
  storage_usage: number
}

export function viewAccount(cfg: NetworkConfig, accountId: string) {
  return query<AccountView>(cfg, { request_type: 'view_account', finality: 'final', account_id: accountId })
}

export interface AccessKeyInfo {
  public_key: string
  access_key: {
    nonce: number
    permission:
      | 'FullAccess'
      | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } }
  }
}

export async function viewAccessKeys(cfg: NetworkConfig, accountId: string) {
  const r = await query<{ keys: AccessKeyInfo[] }>(cfg, {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: accountId,
  })
  return r.keys
}

/** Function-call keys on `accountId` that are scoped to our contract. */
export async function findSessionKeys(cfg: NetworkConfig, accountId: string) {
  const keys = await viewAccessKeys(cfg, accountId)
  return keys.filter(
    (k) => k.access_key.permission !== 'FullAccess' && k.access_key.permission.FunctionCall.receiver_id === cfg.contractId,
  )
}

const YOCTO_PER_NEAR = 10n ** 24n

export function formatNear(yocto: string, decimals = 4): string {
  const v = BigInt(yocto)
  const whole = v / YOCTO_PER_NEAR
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, decimals).replace(/0+$/, '')
  return frac ? `${whole.toLocaleString()}.${frac}` : whole.toLocaleString()
}
