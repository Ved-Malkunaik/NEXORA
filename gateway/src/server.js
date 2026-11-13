#!/usr/bin/env node
// Nexora gateway as a standalone Node server (local development, or a VM such as Oracle Cloud).
// The gateway itself is app.js; on Vercel the same app runs as a function (api/gateway.js).
//
// State: Upstash Redis if KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*) are set,
// otherwise gateway/.data/store.json.
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { storeFromEnv } from './store.js'

const PORT = Number(process.env.PORT || 8787)
/** Interface to listen on. On a server behind a reverse proxy, set BIND=127.0.0.1 so only the proxy can reach it. */
const BIND = process.env.BIND || '0.0.0.0'

const here = dirname(fileURLToPath(import.meta.url))
const store = storeFromEnv(process.env, join(here, '..', '.data', 'store.json'))
const app = createApp({ store })

createServer((req, res) => void app.handle(req, res)).listen(PORT, BIND, () => {
  console.log(`Nexora gateway on http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}`)
  for (const line of app.describe()) console.log(`  ${line}`)
})

// Settle sessions that expired with metered usage (see sweep in app.js).
setInterval(() => void app.sweep().catch((e) => console.warn(`sweep: ${e.message}`)), app.SWEEP_MS).unref()
