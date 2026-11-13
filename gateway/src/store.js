// Where the gateway keeps its state: metering, chat keys, paid notes, spent-note markers, anonymous
// sessions, replay markers, locks and rate-limit counters.
//
//   createFileStore(path)   one process (local dev, a VM): a JSON file, written on every change
//   createMemoryStore()     tests
//   createRedisStore(...)   Upstash Redis over its REST API: shared by every serverless instance
//   storeFromEnv(env)       Redis when its URL and token are set, otherwise a file under gateway/.data
//
// Every value is JSON. The operations are the few the gateway needs, each atomic on Redis:
//   get, set (optionally only-if-absent and/or with an expiry), del, incr (expiry set on first
//   increment), sadd/srem/smembers, rpush/lrange.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** In-process store; `persist(snapshot)` is called after every change (file store), or never (tests). */
function createLocalStore({ load = () => ({}), persist = () => {}, now = () => Date.now() } = {}) {
  /** key -> { v: value, exp?: ms } */
  const data = new Map(Object.entries(load()))
  const live = (k) => {
    const e = data.get(k)
    if (!e) return undefined
    if (e.exp && now() >= e.exp) {
      data.delete(k)
      return undefined
    }
    return e
  }
  const save = () => persist(Object.fromEntries(data))
  return {
    kind: 'file',
    async get(k) {
      return live(k)?.v ?? null
    },
    async set(k, v, { nx = false, px } = {}) {
      if (nx && live(k)) return false
      data.set(k, px ? { v, exp: now() + px } : { v })
      save()
      return true
    },
    async del(k) {
      data.delete(k)
      save()
    },
    async incr(k, ttlMs) {
      const e = live(k)
      const n = (e ? Number(e.v) : 0) + 1
      data.set(k, { v: n, ...(e?.exp ? { exp: e.exp } : ttlMs ? { exp: now() + ttlMs } : {}) })
      save()
      return n
    },
    async sadd(k, m) {
      const s = new Set(live(k)?.v ?? [])
      s.add(String(m))
      data.set(k, { v: [...s] })
      save()
    },
    async srem(k, m) {
      const s = new Set(live(k)?.v ?? [])
      s.delete(String(m))
      data.set(k, { v: [...s] })
      save()
    },
    async smembers(k) {
      return [...(live(k)?.v ?? [])]
    },
    async rpush(k, v) {
      const list = live(k)?.v ?? []
      data.set(k, { v: [...list, v] })
      save()
      return list.length + 1
    },
    async lrange(k) {
      return [...(live(k)?.v ?? [])]
    },
  }
}

export const createMemoryStore = (opts = {}) => createLocalStore(opts)

export function createFileStore(path, { now } = {}) {
  return createLocalStore({
    now,
    load: () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return {}
      }
    },
    persist: (snapshot) => {
      mkdirSync(dirname(path), { recursive: true })
      // Write then rename, so a crash never leaves half a file. On Windows a sync tool or virus
      // scanner can hold the file for a moment and make the rename fail; then write it directly.
      const text = JSON.stringify(snapshot)
      try {
        writeFileSync(`${path}.tmp`, text)
        renameSync(`${path}.tmp`, path)
      } catch (e) {
        if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e
        writeFileSync(path, text)
      }
    },
  })
}

/** Upstash Redis REST API: POST a command as a JSON array, get back {result} or {error}. */
export function createRedisStore({ url, token, prefix = 'nexora:', fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, '')
  async function cmd(...args) {
    const res = await fetchImpl(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.error) throw new Error(`Redis ${args[0]} failed: ${body.error ?? res.status}`)
    return body.result
  }
  const key = (k) => prefix + k
  const parse = (s) => (s === null || s === undefined ? null : JSON.parse(s))
  return {
    kind: 'redis',
    async get(k) {
      return parse(await cmd('GET', key(k)))
    },
    async set(k, v, { nx = false, px } = {}) {
      const r = await cmd('SET', key(k), JSON.stringify(v), ...(px ? ['PX', Math.max(1, Math.round(px))] : []), ...(nx ? ['NX'] : []))
      return r === 'OK'
    },
    async del(k) {
      await cmd('DEL', key(k))
    },
    async incr(k, ttlMs) {
      const n = Number(await cmd('INCR', key(k)))
      if (n === 1 && ttlMs) await cmd('PEXPIRE', key(k), Math.round(ttlMs))
      return n
    },
    async sadd(k, m) {
      await cmd('SADD', key(k), m)
    },
    async srem(k, m) {
      await cmd('SREM', key(k), m)
    },
    async smembers(k) {
      return (await cmd('SMEMBERS', key(k))) ?? []
    },
    async rpush(k, v) {
      return Number(await cmd('RPUSH', key(k), JSON.stringify(v)))
    },
    async lrange(k) {
      return ((await cmd('LRANGE', key(k), 0, -1)) ?? []).map(parse)
    },
  }
}

/**
 * Find the Upstash REST URL and token. Vercel's integration names them KV_REST_API_URL/_TOKEN, or with
 * a custom prefix (e.g. STORAGE_KV_REST_API_URL); Upstash's own names are UPSTASH_REDIS_REST_URL/_TOKEN.
 */
export function redisFromEnv(env) {
  const pairs = [['KV_REST_API_URL', 'KV_REST_API_TOKEN'], ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']]
  for (const [u, t] of pairs) if (env[u] && env[t]) return { url: env[u], token: env[t] }
  // Prefixed names: <PREFIX>_KV_REST_API_URL with its matching <PREFIX>_KV_REST_API_TOKEN.
  for (const name of Object.keys(env).sort()) {
    for (const [u, t] of pairs) {
      if (name.endsWith(`_${u}`) && env[name]) {
        const tokenName = name.slice(0, -u.length) + t
        if (env[tokenName]) return { url: env[name], token: env[tokenName] }
      }
    }
  }
  return null
}

/** Redis if configured (see redisFromEnv), otherwise a local file. */
export function storeFromEnv(env, filePath) {
  const redis = redisFromEnv(env)
  if (redis) return createRedisStore({ ...redis, prefix: env.STORE_PREFIX || 'nexora:' })
  if (env.VERCEL) {
    // Name the variables that look related (names only, never values) to make the fix obvious.
    const seen = Object.keys(env).filter((k) => /KV|REDIS|UPSTASH/i.test(k))
    throw new Error(
      `No Redis configured. On Vercel the gateway needs Upstash Redis: KV_REST_API_URL and KV_REST_API_TOKEN. ${
        seen.length ? `Related variables found: ${seen.join(', ')}.` : 'No related variables found: connect the database to this project, then redeploy.'
      }`,
    )
  }
  if (!filePath) throw new Error('No Redis configured (KV_REST_API_URL and KV_REST_API_TOKEN), and no file to keep state in.')
  return createFileStore(filePath)
}
