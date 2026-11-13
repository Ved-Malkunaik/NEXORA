// The gateway as one Vercel Function (re-exported by api/gateway.js at the repository root).
//
// vercel.json rewrites /api/<anything> to /api/gateway?__path=<anything>, so this one function serves
// the whole gateway under /api/v1/... on the app's own domain (no CORS, no separate server).
// State is in Upstash Redis (see store.js); without it the function refuses to start.
import { waitUntil } from '@vercel/functions'
import { createApp } from './app.js'
import { storeFromEnv } from './store.js'

let app = null
let startError = null
try {
  app = createApp({ store: storeFromEnv(process.env) })
} catch (e) {
  startError = e
}

/** Put back the gateway path the browser asked for, e.g. /api/v1/chat?x=1 -> /v1/chat?x=1. */
export function gatewayPath(rawUrl) {
  const url = new URL(rawUrl ?? '/', 'http://gateway')
  let path = url.searchParams.get('__path')
  url.searchParams.delete('__path')
  if (path === null) path = url.pathname.replace(/^\/api(?=\/|$)/, '').replace(/^\/gateway(?=\/|$)/, '')
  path = `/${String(path).replace(/^\/+/, '')}`
  const qs = url.searchParams.toString()
  return qs ? `${path}?${qs}` : path
}

export default async function handler(req, res) {
  if (startError) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: `Gateway is not configured: ${startError.message}` }))
  }
  req.url = gatewayPath(req.url)
  // Settle sessions that expired with metered usage. There is no always-on process on Vercel, so this
  // runs in the background of ordinary requests, at most once a minute across all instances.
  waitUntil(app.sweep().catch((e) => console.warn(`sweep: ${e.message}`)))
  await app.handle(req, res)
}
