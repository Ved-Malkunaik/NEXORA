// What runs the model, as the app should describe it. Copy that claims a TEE is shown only when the
// gateway actually uses one (NEAR AI Cloud). The demo account mirrors the hosted setup (OpenRouter).
import { useClient, useClientQuery } from './context'
import { fetchGatewayHealth, type GatewayHealth } from './live'

export interface Inference {
  /** Prompts run in an attested TEE. */
  tee: boolean
  /** Who runs the model, for display. */
  provider: string
  /** Replies come from a real model (not simulated). */
  live: boolean
}

/** null while the gateway is being asked, or when it cannot be reached. */
export function useInference(): Inference | null {
  const client = useClient()
  const health = useClientQuery<GatewayHealth | null>((c) => (c.kind === 'live' ? fetchGatewayHealth() : Promise.resolve(null)), [])
  if (client.kind !== 'live') return { tee: false, provider: 'OpenRouter (simulated)', live: false }
  const h = health.data
  if (!h) return null
  return {
    tee: h.tee ?? h.provider === 'nearai',
    provider: h.provider === 'openrouter' ? 'OpenRouter' : h.provider === 'nearai' ? 'NEAR AI Cloud' : 'Simulated',
    live: !!h.model_live,
  }
}
