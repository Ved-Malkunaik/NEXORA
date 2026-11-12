#!/usr/bin/env node
// Nexora gateway: the only account allowed to settle sessions on the credits contract.
//
//   POST /v1/chat                      stream a reply (NDJSON), metered against the on-chain cap
//   GET  /v1/metering?ids=1,2          metered spend per open session
//   POST /v1/sessions/:id/settle       settle_session on-chain with the gateway's own metered total
//   GET  /v1/health                    config + whether a signing key is loaded
//
// The browser never tells the gateway how much to charge: cost is metered here, per token.
// Prompts and replies are not stored; only per-session token counts and cost (.data/metering.json).
//
// KNOWN LIMIT (prototype): requests name their account_id without proving it. A production gateway
// must authenticate the caller (e.g. a NEP-413 signed message per session). See docs/SECURITY_REPORT.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGateway, readConfig, receiptHash } from './settlement.js'
import { MODEL_ID, answerFor, proofFor } from './model.js'

/** Same price as the UI shows: 0.00002 NEAR per token. */
export const YOCTO_PER_TOKEN = 20_000_000_000_000_000_000n
const PORT = Number(process.env.PORT || 8787)
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',')

const here = dirname(fileURLToPath(import.meta.url))
const DATA = join(here, '..', '.data', 'metering.json')

/** sessionId -> { metered: string (yocto), tokens: number, mode, requests } */
let metering = {}
try {
  metering = JSON.parse(readFileSync(DATA, 'utf8'))
} catch {
  metering = {}
}
const persist = () => {
  mkdirSync(dirname(DATA), { recursive: true })
  writeFileSync(DATA, JSON.stringify(metering, null, 2))
}

const cfg = readConfig()
const gw = createGateway(cfg)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function send(res, status, body, origin) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors(origin) })
  res.end(JSON.stringify(body))
}

function cors(origin) {
  return origin && ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
    : {}
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 64_000) throw new Error('Request too large')
  }
  return raw ? JSON.parse(raw) : {}
}

const nowNs = () => BigInt(Date.now()) * 1_000_000n

/** Load and check a session against the chain. Throws {status, code, error}. */
async function liveSession(sessionId, accountId) {
  if (!/^\d+$/.test(String(sessionId))) throw { status: 400, code: 'SESSION_CLOSED', error: 'Invalid session id' }
  const s = await gw.getSession(sessionId)
  if (!s) throw { status: 404, code: 'SESSION_CLOSED', error: 'This session is closed. Open a new one to keep chatting.' }
  if (s.owner !== accountId) throw { status: 403, code: 'SESSION_CLOSED', error: 'This session belongs to another account.' }
  return s
}

async function handleChat(req, res, origin) {
  const { session_id, account_id, mode, prompt } = await readJson(req)
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) return send(res, 400, { error: 'Prompt must be 1–8000 characters' }, origin)
  let s
  try {
    s = await liveSession(session_id, account_id)
  } catch (e) {
    return send(res, e.status ?? 502, { code: e.code ?? 'GATEWAY_DOWN', error: e.error ?? String(e.message ?? e) }, origin)
  }
  if (nowNs() > BigInt(s.expires_at)) return send(res, 409, { code: 'SESSION_EXPIRED', error: 'This session has expired. End it to settle, or open a new one.' }, origin)

  const m = (metering[session_id] ??= { metered: '0', tokens: 0, mode: mode === 'A' ? 'A' : 'B', requests: 0 })
  const cap = BigInt(s.cap)
  if (BigInt(m.metered) >= cap) return send(res, 409, { code: 'CAP_REACHED', error: 'This session reached its spending cap. End it and open a new one to continue.' }, origin)

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', ...cors(origin) })
  const emit = (ev) => res.write(`${JSON.stringify(ev)}\n`)
  let closed = false
  req.on('close', () => (closed = true))

  const promptTokens = BigInt(Math.ceil(prompt.length / 4))
  const start = BigInt(m.metered)
  let tokens = 0n
  let capHit = false
  await sleep(400)
  for (const part of answerFor(prompt, m.mode).split(/(\s+)/)) {
    if (closed) break
    if (part.trim()) tokens++
    if (start + (promptTokens + tokens) * YOCTO_PER_TOKEN > cap) {
      capHit = true
      break
    }
    emit({ type: 'token', text: part })
    if (part.trim()) await sleep(20 + Math.random() * 35)
  }
  // Charge what was actually generated, never above the cap.
  let cost = (promptTokens + tokens) * YOCTO_PER_TOKEN
  if (start + cost > cap) cost = cap - start
  m.metered = (start + cost).toString()
  m.tokens += Number(promptTokens + tokens)
  m.requests += 1
  persist()

  if (capHit) emit({ type: 'error', code: 'CAP_REACHED', message: 'This session reached its spending cap. End it and open a new one to continue.' })
  else {
    emit({ type: 'usage', tokens: Number(promptTokens + tokens), cost: cost.toString(), metered: m.metered })
    emit({ type: 'proof', proof: proofFor(session_id, m.mode, m.requests) })
    emit({ type: 'done' })
  }
  res.end()
}

async function handleSettle(req, res, origin, sessionId) {
  const { account_id } = await readJson(req)
  let s
  try {
    s = await liveSession(sessionId, account_id)
  } catch (e) {
    return send(res, e.status ?? 502, { error: e.error ?? String(e.message ?? e) }, origin)
  }
  if (nowNs() > BigInt(s.settle_deadline)) return send(res, 409, { error: 'Settlement window has closed. Reclaim the session instead.' }, origin)
  const m = metering[sessionId] ?? { metered: '0', tokens: 0, requests: 0 }
  const spent = BigInt(m.metered) > BigInt(s.cap) ? BigInt(s.cap) : BigInt(m.metered)
  const record = { session_id: String(sessionId), account_id, spent_yocto: spent.toString(), tokens: m.tokens, requests: m.requests, model: MODEL_ID, settled_at: new Date().toISOString() }
  try {
    const result = await gw.settleExact(sessionId, spent.toString(), receiptHash(record))
    delete metering[sessionId]
    persist()
    const receipts = await gw.getReceipts(account_id)
    const receipt = receipts.find((r) => r.session_id === String(sessionId))
    console.log(`settled #${sessionId} for ${account_id}: ${spent} yocto (tx ${result.tx})`)
    return send(res, 200, { receipt, tx: result.tx }, origin)
  } catch (e) {
    return send(res, 502, { error: `Settlement failed: ${e instanceof Error ? e.message : e}` }, origin)
  }
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors(origin))
      return res.end()
    }
    if (req.method === 'GET' && url.pathname === '/v1/health')
      return send(res, 200, { ok: true, contract: cfg.contractId, gateway: cfg.gatewayId ?? null, can_settle: !!(cfg.gatewayId && cfg.privateKey), model: MODEL_ID }, origin)
    if (req.method === 'GET' && url.pathname === '/v1/metering') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
      return send(res, 200, Object.fromEntries(ids.map((id) => [id, metering[id]?.metered ?? '0'])), origin)
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat') return await handleChat(req, res, origin)
    const settle = url.pathname.match(/^\/v1\/sessions\/(\d+)\/settle$/)
    if (req.method === 'POST' && settle) return await handleSettle(req, res, origin, settle[1])
    send(res, 404, { error: 'Not found' }, origin)
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) }, origin)
    else res.end()
  }
})

server.listen(PORT, () => {
  console.log(`Nexora gateway on http://localhost:${PORT}`)
  console.log(`  contract ${cfg.contractId} via ${cfg.rpcUrl}`)
  console.log(`  settles as ${cfg.gatewayId ?? '(no GATEWAY_ACCOUNT_ID)'}${cfg.privateKey ? '' : '  (no GATEWAY_PRIVATE_KEY: chat works, settling will fail)'}`)
  console.log(`  model ${MODEL_ID}`)
})
