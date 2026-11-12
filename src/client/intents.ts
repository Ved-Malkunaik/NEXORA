// NEAR Intents dry-run quotes from the public 1Click API (https://docs.near-intents.org).
// Dry quotes price a swap without creating a deposit address, so nothing can be sent or signed.
//
// Route: <asset> -> wNEAR, delivered to the user's NEAR Intents balance. 1Click does not currently
// quote delivery straight to a NEAR account, so the credits deposit is a second step.
import type { IntentsAsset, IntentsQuote } from './types'

const ONECLICK = import.meta.env.VITE_ONECLICK_URL || 'https://1click.chaindefuser.com'
const WNEAR = 'nep141:wrap.near'
const QUOTE_TTL_MS = 30_000

/** UI asset id -> 1Click asset id. 'near' needs no swap. */
const ROUTES: Record<string, string | null> = {
  near: null,
  'usdc-eth': 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
  'usdc-base': 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  'usdt-tron': 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near',
}

export const INTENTS_ASSETS: IntentsAsset[] = [
  { id: 'near', symbol: 'NEAR', chain: 'NEAR', decimals: 24 },
  { id: 'usdc-eth', symbol: 'USDC', chain: 'Ethereum', decimals: 6 },
  { id: 'usdc-base', symbol: 'USDC', chain: 'Base', decimals: 6 },
  { id: 'usdt-tron', symbol: 'USDT', chain: 'Tron', decimals: 6 },
]

/** "12.5" with 6 decimals -> "12500000", no floats. */
export function toBaseUnits(amount: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount) || !/[1-9]/.test(amount)) throw new Error('Enter an amount greater than 0')
  const [w, f = ''] = amount.split('.')
  if (f.length > decimals) throw new Error(`At most ${decimals} decimal places`)
  return (BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0')).toString()
}

interface OneClickQuote {
  quote: { amountIn: string; amountOut: string; amountInUsd?: string; amountOutUsd?: string; timeEstimate?: number }
  correlationId?: string
}

/**
 * Real dry-run quote. `accountId` is only where the wNEAR would land; dry quotes never move funds.
 */
export async function oneClickQuote(assetId: string, amountIn: string, accountId: string): Promise<IntentsQuote> {
  const asset = INTENTS_ASSETS.find((a) => a.id === assetId)
  if (!asset || !(assetId in ROUTES)) throw new Error('Unsupported asset')
  const units = toBaseUnits(amountIn, asset.decimals)
  const origin = ROUTES[assetId]

  if (!origin) {
    // NEAR is deposited directly: no swap, no solver fee.
    return {
      quote_id: `direct-${Date.now()}`,
      asset,
      amount_in: amountIn,
      amount_out: units,
      rate: '1 NEAR = 1 NEAR (direct deposit, no swap)',
      fee: '0',
      expires_at: Date.now() + QUOTE_TTL_MS,
      dry: true,
      source: 'direct',
    }
  }

  // Dry quotes are priced from an Intents balance; the price is the same for an origin-chain deposit.
  const recipient = /\.(near|testnet)$|^[0-9a-f]{64}$/.test(accountId) ? accountId : 'intents.near'
  let res: Response
  try {
    res = await fetch(`${ONECLICK}/v0/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: origin,
        depositType: 'INTENTS',
        destinationAsset: WNEAR,
        amount: units,
        refundTo: recipient,
        refundType: 'INTENTS',
        recipient,
        recipientType: 'INTENTS',
        deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    })
  } catch {
    throw new Error('NEAR Intents (1Click) is not reachable. Try again in a moment.')
  }
  const body = (await res.json().catch(() => ({}))) as OneClickQuote & { message?: string }
  if (!res.ok || !body.quote) throw new Error(body.message ? `1Click: ${body.message}` : `1Click error ${res.status}`)

  const q = body.quote
  const out = BigInt(q.amountOut)
  // Fee = the USD gap between what goes in and what comes out, shown in NEAR at the quote's own rate.
  const inUsd = Number(q.amountInUsd ?? 0)
  const outUsd = Number(q.amountOutUsd ?? 0)
  const fee = outUsd > 0 && inUsd > outUsd ? (out * BigInt(Math.round(((inUsd - outUsd) / outUsd) * 1e9))) / 10n ** 9n : 0n
  const perUnit = Number(out / 10n ** 18n) / 1e6 / Number(amountIn)
  return {
    quote_id: body.correlationId ?? `1click-${Date.now()}`,
    asset,
    amount_in: amountIn,
    amount_out: out.toString(),
    rate: `1 ${asset.symbol} ≈ ${perUnit.toFixed(4)} NEAR`,
    fee: fee.toString(),
    expires_at: Date.now() + QUOTE_TTL_MS,
    dry: true,
    source: '1click',
  }
}
