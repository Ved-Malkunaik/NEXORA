import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFileStore, createMemoryStore, createRedisStore, storeFromEnv } from '../src/store.js'
import { gatewayPath } from '../src/vercel.js'

/**
 * A stand-in for Upstash's REST API: POST a JSON array command, get {result}. Implements the commands
 * the store uses, with Redis semantics (strings, NX, PX, INCR, sets, lists).
 */
async function fakeUpstash(token = 'tok') {
  const kv = new Map()
  const exp = new Map()
  const alive = (k) => {
    if (exp.has(k) && Date.now() >= exp.get(k)) {
      kv.delete(k)
      exp.delete(k)
    }
    return kv.has(k)
  }
  const commands = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Unauthorized' }))
    }
    const [cmd, k, ...a] = JSON.parse(body)
    commands.push(cmd)
    let result = null
    switch (cmd) {
      case 'GET':
        result = alive(k) ? kv.get(k) : null
        break
      case 'SET': {
        const nx = a.includes('NX')
        const pi = a.indexOf('PX')
        if (nx && alive(k)) break
        kv.set(k, a[0])
        if (pi >= 0) exp.set(k, Date.now() + Number(a[pi + 1]))
        else exp.delete(k)
        result = 'OK'
        break
      }
      case 'DEL':
        result = kv.delete(k) ? 1 : 0
        break
      case 'INCR':
        result = (alive(k) ? Number(kv.get(k)) : 0) + 1
        kv.set(k, String(result))
        break
      case 'PEXPIRE':
        exp.set(k, Date.now() + Number(a[0]))
        result = 1
        break
      case 'SADD':
        kv.set(k, new Set([...(alive(k) ? kv.get(k) : []), a[0]]))
        result = 1
        break
      case 'SREM': {
        const s = new Set(alive(k) ? kv.get(k) : [])
        s.delete(a[0])
        kv.set(k, s)
        result = 1
        break
      }
      case 'SMEMBERS':
        result = [...(alive(k) ? kv.get(k) : [])]
        break
      case 'RPUSH':
        kv.set(k, [...(alive(k) ? kv.get(k) : []), a[0]])
        result = kv.get(k).length
        break
      case 'LRANGE':
        result = alive(k) ? kv.get(k) : []
        break
      default:
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: `ERR unknown command ${cmd}` }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ result }))
  })
  await new Promise((r) => server.listen(0, r))
  return { url: `http://127.0.0.1:${server.address().port}`, commands, close: () => server.close() }
}

/** The same behaviour is required of every store. */
async function contract(store) {
  assert.equal(await store.get('a'), null)
  assert.equal(await store.set('a', { x: 1 }), true)
  assert.deepEqual(await store.get('a'), { x: 1 })
  assert.equal(await store.set('a', 2, { nx: true }), false, 'NX must not overwrite')
  assert.deepEqual(await store.get('a'), { x: 1 })
  await store.del('a')
  assert.equal(await store.get('a'), null)

  assert.equal(await store.set('t', 'v', { px: 40 }), true)
  assert.equal(await store.get('t'), 'v')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(await store.get('t'), null, 'PX must expire')
  assert.equal(await store.set('t', 'again', { nx: true }), true, 'an expired key can be taken again')

  assert.equal(await store.incr('n', 10_000), 1)
  assert.equal(await store.incr('n', 10_000), 2)

  await store.sadd('s', '1')
  await store.sadd('s', '2')
  await store.sadd('s', '1')
  assert.deepEqual((await store.smembers('s')).sort(), ['1', '2'])
  await store.srem('s', '1')
  assert.deepEqual(await store.smembers('s'), ['2'])

  assert.equal(await store.rpush('l', { c: '1' }), 1)
  assert.equal(await store.rpush('l', { c: '2' }), 2)
  assert.deepEqual(await store.lrange('l'), [{ c: '1' }, { c: '2' }])
}

test('memory store behaves like Redis', async () => {
  await contract(createMemoryStore())
})

test('file store behaves like Redis and survives a restart', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'nexora-store-')), 'store.json')
  await contract(createFileStore(path))
  const again = createFileStore(path)
  assert.deepEqual(await again.lrange('l'), [{ c: '1' }, { c: '2' }])
  assert.deepEqual(await again.smembers('s'), ['2'])
})

test('Redis store speaks the Upstash REST protocol', async () => {
  const fake = await fakeUpstash('tok')
  try {
    const store = createRedisStore({ url: `${fake.url}/`, token: 'tok' })
    await contract(store)
    assert.ok(fake.commands.includes('PEXPIRE'))
    await assert.rejects(createRedisStore({ url: fake.url, token: 'wrong' }).get('a'), /Redis GET failed: Unauthorized/)
  } finally {
    fake.close()
  }
})

test('storeFromEnv: Redis when configured, a file otherwise, and never a file on Vercel', () => {
  assert.equal(storeFromEnv({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }).kind, 'redis')
  assert.equal(storeFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }).kind, 'redis')
  assert.equal(storeFromEnv({}, join(mkdtempSync(join(tmpdir(), 'nexora-store-')), 's.json')).kind, 'file')
  assert.throws(() => storeFromEnv({ VERCEL: '1' }), /needs Upstash Redis/)
  assert.equal(storeFromEnv({ STORAGE_KV_REST_API_URL: 'https://x', STORAGE_KV_REST_API_TOKEN: 't' }).kind, 'redis', 'custom prefix')
  assert.throws(() => storeFromEnv({ VERCEL: '1', KV_URL: 'redis://secret' }), (e) => /Related variables found: KV_URL\./.test(e.message) && !e.message.includes('secret'))
})

test('Vercel requests are mapped back to gateway paths', () => {
  assert.equal(gatewayPath('/api/gateway?__path=v1/chat'), '/v1/chat')
  assert.equal(gatewayPath('/api/gateway?__path=v1%2Fsessions%2F12%2Fsettle'), '/v1/sessions/12/settle')
  assert.equal(gatewayPath('/api/gateway?ids=1,2&__path=v1/metering'), '/v1/metering?ids=1%2C2')
  assert.equal(gatewayPath('/api/v1/health'), '/v1/health')
  assert.equal(gatewayPath('/api/v1/metering?ids=7'), '/v1/metering?ids=7')
})
