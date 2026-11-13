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
    // Some free models (e.g. ERNIE 5.5 Flash) always reason before answering and count that against
    // max_tokens. Keep it short and out of the stream; models without reasoning ignore this.
    reasoning: { effort: 'low', exclude: true },
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
 * Account-wide free-tier limits, counted in the shared store so every gateway instance sees the same
 * numbers. `take()` resolves to null when a call is allowed (and counts it), or a user-facing reason.
 * Minutes are fixed windows; days follow OpenRouter's reset at 00:00 UTC.
 */
export function createLimiter({ store, perMinute = 18, perDay = 1000, now = () => Date.now() }) {
  const keys = () => {
    const t = now()
    return { minute: `rl:m:${Math.floor(t / 60_000)}`, day: `rl:d:${new Date(t).toISOString().slice(0, 10)}` }
  }
  return {
    async take() {
      const k = keys()
      const [day, minute] = await Promise.all([store.get(k.day), store.get(k.minute)])
      if (Number(day ?? 0) >= perDay) return 'The free model’s daily request limit is used up. It resets at 00:00 UTC. Nothing was charged.'
      if (Number(minute ?? 0) >= perMinute) return 'The free model is busy right now. Try again in a minute. Nothing was charged.'
      await Promise.all([store.incr(k.minute, 120_000), store.incr(k.day, 2 * 86_400_000)])
      return null
    },
    async stats() {
      const k = keys()
      const [day, minute] = await Promise.all([store.get(k.day), store.get(k.minute)])
      return { last_minute: Number(minute ?? 0), today: Number(day ?? 0), per_minute: perMinute, per_day: perDay }
    },
  }
}
