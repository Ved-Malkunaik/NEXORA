import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

/** A stand-in for OpenRouter that replies with `status` and the given SSE chunks, and records requests. */
async function fakeOpenRouter(status, chunks) {
  const seen = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    seen.push({ headers: req.headers, body: JSON.parse(body) })
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { code: status, message: 'nope' } }))
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const c of chunks) res.write(c)
    res.end()
  })
  await new Promise((r) => server.listen(0, r))
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${server.address().port}/api/v1`
  const mod = await import(`../src/openrouter.js?t=${Date.now()}${Math.random()}`)
  return { mod, seen, close: () => server.close() }
}

const run = async (mod, opts = {}) => {
  const events = []
  for await (const ev of mod.streamOpenRouter({ apiKey: 'k', models: ['a:free', 'b:free'], messages: [{ role: 'user', content: 'hi' }], ...opts })) events.push(ev)
  return events
}

test('streams text, skips keep-alive comments, and reports the model and usage', async () => {
  const { mod, seen, close } = await fakeOpenRouter(200, [
    ': OPENROUTER PROCESSING\n\n',
    'data: {"id":"gen-1","model":"b:free","provider":"Nvidia","choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"id":"gen-1","model":"b:free","choices":[{"delta":{"reasoning":"thinking…"}}]}\n\n',
    'data: {"id":"gen-1","model":"b:free","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ])
  const events = await run(mod, { siteUrl: 'https://nexora.example', dataCollection: 'deny' })
  close()
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello')
  assert.deepEqual(events.at(-1), { type: 'end', id: 'gen-1', model: 'b:free', provider: 'Nvidia', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
  const { headers, body } = seen[0]
  assert.equal(headers.authorization, 'Bearer k')
  assert.equal(headers['http-referer'], 'https://nexora.example')
  assert.deepEqual(body.models, ['a:free', 'b:free'])
  assert.equal(body.stream, true)
  assert.deepEqual(body.provider, { data_collection: 'deny' })
})

test('errors become clear messages', async () => {
  for (const [status, re] of [
    [429, /busy right now/],
    [401, /rejected the gateway’s API key/],
    [402, /out of credits/],
  ]) {
    const { mod, close } = await fakeOpenRouter(status, [])
    await assert.rejects(run(mod), (e) => e instanceof mod.UpstreamError && re.test(e.message))
    close()
  }
  // an error sent inside the stream after it started
  const { mod, close } = await fakeOpenRouter(200, ['data: {"id":"g","choices":[{"delta":{"content":"par"}}]}\n\n', 'data: {"error":{"code":429,"message":"Rate limit exceeded"}}\n\n'])
  await assert.rejects(run(mod), /busy right now/)
  close()
})

test('the limiter enforces per-minute and per-day caps and resets', async () => {
  const { createLimiter } = await import('../src/openrouter.js')
  const { createMemoryStore } = await import('../src/store.js')
  let t = Date.UTC(2026, 10, 13, 23, 59, 0)
  const lim = createLimiter({ store: createMemoryStore({ now: () => t }), perMinute: 2, perDay: 3, now: () => t })
  assert.equal(await lim.take(), null)
  assert.equal(await lim.take(), null)
  assert.match(await lim.take(), /busy right now/)
  t += 61_000 // next minute, and past UTC midnight: the day count resets too
  assert.equal(await lim.take(), null)
  assert.equal((await lim.stats()).today, 1)
  assert.equal(await lim.take(), null)
  t += 61_000
  assert.equal(await lim.take(), null)
  assert.match(await lim.take(), /daily request limit/)
})

test('model list: comma-separated, at most three', async () => {
  const { openRouterModels } = await import('../src/openrouter.js')
  assert.deepEqual(openRouterModels({ OPENROUTER_MODELS: ' a:free , b:free,c:free,d:free ' }), ['a:free', 'b:free', 'c:free'])
  assert.equal(openRouterModels({}).length, 2)
})
