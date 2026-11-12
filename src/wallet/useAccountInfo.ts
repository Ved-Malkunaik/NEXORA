import { useCallback, useEffect, useState } from 'react'
import { findSessionKeys, viewAccount, type AccessKeyInfo, type AccountView } from '../lib/rpc'
import { useNear } from './context'

/** On-chain view of the signed-in account: balance and the scoped session key(s). */
export function useAccountInfo() {
  const { accountId, config, isDemo } = useNear()
  const [account, setAccount] = useState<AccountView | null>(null)
  const [sessionKeys, setSessionKeys] = useState<AccessKeyInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!accountId || isDemo) {
      setAccount(null)
      setSessionKeys(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([viewAccount(config, accountId), findSessionKeys(config, accountId)])
      .then(([acc, keys]) => {
        if (cancelled) return
        setAccount(acc)
        setSessionKeys(keys)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [accountId, config, tick, isDemo])

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { account, sessionKeys, loading, error, refresh }
}
