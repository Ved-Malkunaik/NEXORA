// OpenRouter: free open models through one OpenAI-compatible API.
//
// NOT private inference. OpenRouter and the provider that runs the model can read every prompt, and
// free endpoints may log or train on them. There is no TEE and nothing to attest. The app says so.
//
// Free-tier limits (https://openrouter.ai/docs/limits): 20 requests per minute for the whole account,
// and 50 requests per day (1000 once the account has bought 10 credits). The gateway keeps its own
// count and refuses before calling upstream, so a busy minute costs users nothing.

export const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'

/** Models to try in order. OpenRouter moves to the next one when a model is down or rate-limited. */
export function openRouterModels(env = process.env) {
  const list = (env.OPENROUTER_MODELS || 'google/gemma-4-31b-it:free,nvidia/nemotron-3.5-super-vl:free')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
  return list.slice(0, 3) // OpenRouter accepts at most 3 models in a fallback list
}

/** An error the chat can explain to the user. `status` is the upstream HTTP status, if any. */
export class UpstreamError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.status = status
    this.code = code
  }
}

function explain(status, body) {
  let msg = ''
  try {
    const j = JSON.parse(body)
    msg = j?.error?.message ?? ''
  } catch {
    msg = body.slice(0, 160)
  }
  if (status === 429) return new UpstreamError('The free model is busy right now (OpenRouter rate limit). Try again in a minute.', { status, code: 'RATE_LIMITED' })
  if (status === 401 || status === 403) return new UpstreamError('OpenRouter rejected the gateway’s API key.', { status, code: 'AUTH' })
  if (status === 402) return new UpstreamError('The OpenRouter account is out of credits.', { status, code: 'CREDITS' })
  if (status === 404 && /data policy/i.test(msg)) return new UpstreamError('No free model is available under the account’s privacy settings on OpenRouter.', { status, code: 'POLICY' })
  return new UpstreamError(`OpenRouter ${status}${msg ? `: ${msg}` : ''}`, { status })
}

/**
 * Stream a chat completion. Yields {type:'delta', text} and finally
 * {type:'end', id, model, provider, usage}. Throws UpstreamError on failure, including errors that
 * OpenRouter sends inside the stream after it has started.
 */
export async function* streamOpenRouter({ apiKey, models, messages, maxTokens = 1024, signal, siteUrl, dataCollection }) {
  const body = {
    model: models[0],
    ...(models.length > 1 ? { models } : {}),
    messages,
    stream: true,
    max_tokens: maxTokens,
    ...(dataCollection === 'deny' ? { provider: { data_collection: 'deny' } } : {}),
  }
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(siteUrl ? { 'HTTP-Referer': siteUrl } : {}),
      'X-Title': 'Nexora',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) throw explain(res.status, await res.text().catch(() => ''))

  const dec = new TextDecoder()
  let buf = ''
  let id = null
  let model = null
  let provider = null
  let usage = null
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      // Lines starting with ':' are keep-alive comments ("OPENROUTER PROCESSING").
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let ev
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      if (ev.error) throw explain(Number(ev.error.code) || 502, JSON.stringify(ev))
      id ??= ev.id ?? null
      model = ev.model ?? model
      provider = ev.provider ?? provider
      if (ev.usage) usage = ev.usage
      const choice = ev.choices?.[0]
      if (choice?.finish_reason === 'error') throw new UpstreamError('The model stopped with an error. Try again.', { status: 502 })
      const text = choice?.delta?.content
      if (text) yield { type: 'delta', text }
    }
  }
  yield { type: 'end', id, model: model ?? models[0], provider, usage }
}

/**
 * Sliding-window limiter for the account-wide free-tier limits. `take()` returns null when a call is
 * allowed (and counts it), or a user-facing reason when it is not.
 */
export function createLimiter({ perMinute = 18, perDay = 1000, now = () => Date.now() } = {}) {
  let minute = []
  let day = { key: '', count: 0 }
  const dayKey = () => new Date(now()).toISOString().slice(0, 10) // OpenRouter resets daily at UTC midnight
  return {
    take() {
      const t = now()
      minute = minute.filter((x) => t - x < 60_000)
      if (day.key !== dayKey()) day = { key: dayKey(), count: 0 }
      if (day.count >= perDay) return 'The free model’s daily request limit is used up. It resets at 00:00 UTC. Nothing was charged.'
      if (minute.length >= perMinute) return 'The free model is busy right now. Try again in a minute. Nothing was charged.'
      minute.push(t)
      day.count++
      return null
    },
    /** Give back a call that never reached the model (e.g. the user left before it started). */
    refund() {
      minute.pop()
      if (day.count > 0) day.count--
    },
    stats() {
      const t = now()
      return { last_minute: minute.filter((x) => t - x < 60_000).length, today: day.key === dayKey() ? day.count : 0, per_minute: perMinute, per_day: perDay }
    },
  }
}
