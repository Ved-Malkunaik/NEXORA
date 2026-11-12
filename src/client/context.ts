import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MockClient } from './mock'
import type { NexoraClient } from './types'

export const ClientContext = createContext<NexoraClient | null>(null)

export function useClient(): NexoraClient {
  const c = useContext(ClientContext)
  if (!c) throw new Error('useClient must be used inside <ClientProvider>')
  return c
}

/** The mock's developer controls, or null when running live. */
export function useMockControls(): MockClient | null {
  const c = useClient()
  return c instanceof MockClient ? c : null
}

/** Re-renders whenever the client's state changes. */
export function useClientVersion(): number {
  const c = useClient()
  return useSyncExternalStore(
    (l) => c.subscribe(l),
    () => c.getVersion(),
  )
}

export interface Query<T> {
  data: T | undefined
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * Load data from the client and reload it whenever client state changes.
 * Keeps showing the previous data while refreshing (no flicker), `loading` is true
 * only until the first result.
 */
export function useClientQuery<T>(load: (c: NexoraClient) => Promise<T>, deps: unknown[]): Query<T> {
  const client = useClient()
  const version = useClientVersion()
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    setLoaded(false)
    setData(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ...deps])

  useEffect(() => {
    let cancelled = false
    loadRef
      .current(client)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, version, tick, ...deps])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, loading: !loaded && data === undefined, error, reload }
}

/** Ticking clock (ms) for countdowns. Uses the mock clock when running on the mock. */
export function useNow(intervalMs = 1000): number {
  const mock = useMockControls()
  useClientVersion()
  const [now, setNow] = useState(() => (mock ? mock.now() : Date.now()))
  useEffect(() => {
    setNow(mock ? mock.now() : Date.now())
    const id = window.setInterval(() => setNow(mock ? mock.now() : Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [mock, intervalMs])
  return mock ? Math.max(now, mock.now()) : now
}
