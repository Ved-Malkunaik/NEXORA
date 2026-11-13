#!/usr/bin/env node
// Nexora gateway: the only account allowed to settle sessions on the credits contract.
//
//   POST /v1/chat                      stream a reply (NDJSON), metered against the on-chain cap
//   GET  /v1/metering?ids=1,2          metered spend per open session
//   POST /v1/sessions/:id/settle       settle_session on-chain with the gateway's own metered total
//   GET  /v1/notes                     notes: public list of paid note commitments, price, scope
//   POST /v1/notes                     notes: buy a note (public; settles the purchase session)
//   POST /v1/anon/sessions             notes: spend a note with a zero-knowledge proof (anonymous)
//   POST /v1/anon/sessions/:id/close   notes: drop an anonymous session
//   GET  /v1/attestation               fresh, verified NEAR AI Cloud TEE attestation (see nearai.js)
//   GET  /v1/health                    config + whether a signing key is loaded
//
// The browser never tells the gateway how much to charge: cost is metered here, per token.
// Prompts and replies are not stored; only per-session token counts and cost (.data/metering.json).
// With NEARAI_API_KEY set, prompts go to NEAR AI Cloud only after its TEE attestation verifies.
//
// Callers are authenticated per session: each chat/settle request is signed by the session's chat key,
// whose public key the owner registered on-chain in open_session (auth.js).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientKeyFromOpenTx, verifyRequest } from './auth.js'
import { createGateway, readConfig, receiptHash } from './settlement.js'
import { MOCK_MODEL_ID, answerFor } from './model.js'
import { NEARAI_MODEL, attest, fetchSignature, streamChat, verifySignature } from './nearai.js'
import { createNotes } from './notes.js'

const NEARAI_API_KEY = process.env.NEARAI_API_KEY || ''
const LIVE_MODEL = !!NEARAI_API_KEY
const MODEL_ID = LIVE_MODEL ? NEARAI_MODEL : MOCK_MODEL_ID

/** Same price as the UI shows: 0.00002 NEAR per token. */
export const YOCTO_PER_TOKEN = 20_000_000_000_000_000_000n
const PORT = Number(process.env.PORT || 8787)
/** Interface to listen on. On a server behind a reverse proxy, set BIND=127.0.0.1 so only the proxy can reach it. */
const BIND = process.env.BIND || '0.0.0.0'
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

/** sessionId -> chat public key (hex), read once from the open_session transaction. Public data only. */
const KEYS = join(here, '..', '.data', 'session-keys.json')
let sessionKeys = {}
try {
  sessionKeys = JSON.parse(readFileSync(KEYS, 'utf8'))
} catch {
  sessionKeys = {}
}
const persistKeys = () => {
  mkdirSync(dirname(KEYS), { recursive: true })
  writeFileSync(KEYS, JSON.stringify(sessionKeys, null, 2))
}
const seenSignatures = new Map()
/** Set REQUIRE_AUTH=0 only for local experiments: anyone could then spend or settle any session. */
const REQUIRE_AUTH = process.env.REQUIRE_AUTH !== '0'

const cfg = readConfig()
const gw = createGateway(cfg)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Private-payment notes: one fixed price so every note looks the same. Default 0.02 NEAR = 1000 tokens. */
const NOTE_PRICE = process.env.NOTE_PRICE_YOCTO || '20000000000000000000000'
const notes = createNotes({
  file: join(here, '..', '.data', 'notes.json'),
  priceYocto: NOTE_PRICE,
  yoctoPerToken: YOCTO_PER_TOKEN,
  chain: { rpcUrl: cfg.rpcUrl, contractId: cfg.contractId, getSession: gw.getSession, settleExact: gw.settleExact },
})

function send(res, status, body, origin) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors(origin) })
  res.end(JSON.stringify(body))
}

function cors(origin) {
  return origin && ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Nexora-Ts, X-Nexora-Sig, X-Nexora-Open-Tx', Vary: 'Origin' }
    : {}
}

async function readJson(req) {
  if (req.parsedBody !== undefined) return req.parsedBody
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 64_000) throw Object.assign(new Error('Request too large'), { status: 413 })
  }
  req.rawBody = raw // the signature covers these exact bytes
  try {
    req.parsedBody = raw ? JSON.parse(raw) : {}
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON'), { status: 400 })
  }
  if (!req.parsedBody || typeof req.parsedBody !== 'object') throw Object.assign(new Error('Request body must be a JSON object'), { status: 400 })
  return req.parsedBody
}

const nowNs = () => BigInt(Date.now()) * 1_000_000n

/**
 * Load a session from the chain and check the caller: right owner, and the request is signed by the
 * chat key registered in the session's open_session transaction (see auth.js). Throws {status, code, error}.
 */
async function liveSession(sessionId, accountId, req) {
  if (!/^\d+$/.test(String(sessionId))) throw { status: 400, code: 'SESSION_CLOSED', error: 'Invalid session id' }
  const s = await gw.getSession(sessionId)
  if (!s) throw { status: 404, code: 'SESSION_CLOSED', error: 'This session is closed. Open a new one to keep chatting.' }
  if (s.owner !== accountId) throw { status: 403, code: 'SESSION_CLOSED', error: 'This session belongs to another account.' }
  if (!REQUIRE_AUTH) return s
  try {
    let pub = sessionKeys[sessionId]
    if (!pub) {
      pub = await clientKeyFromOpenTx({ rpcUrl: cfg.rpcUrl, contractId: cfg.contractId, txHash: req.headers['x-nexora-open-tx'], owner: s.owner, sessionId })
      sessionKeys[sessionId] = pub
      persistKeys()
    }
    const path = new URL(req.url ?? '/', 'http://gateway').pathname
    verifyRequest({ publicKeyHex: pub, method: req.method, path, sessionId: String(sessionId), ts: req.headers['x-nexora-ts'], sigHex: req.headers['x-nexora-sig'], body: req.rawBody ?? '', seen: seenSignatures })
  } catch (e) {
    throw { status: 401, code: 'SESSION_CLOSED', error: `Not authorised for this session: ${e.message}` }
  }
  return s
}

/** Attestation cache: one verified report per model, refreshed every ATTEST_TTL_MS. */
const ATTEST_TTL_MS = Number(process.env.ATTEST_TTL_MS || 10 * 60_000)
let attestCache = null
let attestPending = null
async function currentAttestation() {
  if (attestCache && Date.now() - attestCache.at < ATTEST_TTL_MS) return attestCache.value
  attestPending ??= attest(NEARAI_MODEL)
    .then((value) => {
      // Only cache a passing report, so a transient verifier failure is retried next request.
      if (value.verified) attestCache = { at: Date.now(), value }
      return value
    })
    .finally(() => (attestPending = null))
  return attestPending
}

const SYSTEM_PROMPT = 'You are Nexora, a private assistant. Answer clearly and concisely.'

/** Last few turns from the browser's local transcript, bounded. */
function cleanHistory(history) {
  if (!Array.isArray(history)) return []
  const out = []
  let budget = 24_000
  for (const h of history.slice(-12).reverse()) {
    if (!h || (h.role !== 'user' && h.role !== 'assistant') || typeof h.content !== 'string' || !h.content) continue
    const content = h.content.slice(0, 8000)
    budget -= content.length
    if (budget < 0) break
    out.unshift({ role: h.role, content })
  }
  return out
}

const estTokens = (text) => BigInt(Math.ceil(text.length / 4))

/**
 * Sessions with a request in flight. One at a time per session: metering reads the running total,
 * streams, then writes it back, so two overlapping requests (or a settle during a reply) would let
 * one of them go uncharged.
 */
const busy = new Set()

async function handleChat(req, res, origin) {
  const body = await readJson(req)
  const key = body.anon_session !== undefined ? `anon:${body.anon_session}` : `chain:${body.session_id}`
  if (busy.has(key)) return send(res, 409, { code: 'GATEWAY_DOWN', error: 'A reply is already in progress for this session. Wait for it to finish.' }, origin)
  busy.add(key)
  try {
    return await chatLocked(req, res, origin)
  } finally {
    busy.delete(key)
  }
}

async function chatLocked(req, res, origin) {
  const body = await readJson(req)
  const { account_id, prompt, history, anon_session } = body
  let session_id = body.session_id
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000) return send(res, 400, { error: 'Prompt must be 1–8000 characters' }, origin)
  let s
  let m
  /** Set for a request paid with a note: no account is involved. */
  let anon = null
  if (anon_session !== undefined) {
    try {
      anon = notes.auth(anon_session, req)
    } catch (e) {
      return send(res, 401, { code: 'SESSION_CLOSED', error: `Not authorised for this session: ${e.message}` }, origin)
    }
    session_id = `anon:${String(anon_session).slice(0, 8)}`
    s = { cap: notes.priceYocto, expires_at: (BigInt(anon.expires_at) * 1_000_000n).toString() }
    m = anon
  } else {
    try {
      s = await liveSession(session_id, account_id, req)
    } catch (e) {
      return send(res, e.status ?? 502, { code: e.code ?? 'GATEWAY_DOWN', error: e.error ?? String(e.message ?? e) }, origin)
    }
  }
  if (nowNs() > BigInt(s.expires_at)) return send(res, 409, { code: 'SESSION_EXPIRED', error: 'This session has expired. End it to settle, or open a new one.' }, origin)

  // An on-chain session is internally mode 'B'; a note-paid session is the anonymous path above.
  m ??= metering[session_id] ??= { metered: '0', tokens: 0, mode: 'B', requests: 0 }
  if (!anon) m.mode = 'B'
  const cap = BigInt(s.cap)
  const start = BigInt(m.metered)
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...cleanHistory(history), { role: 'user', content: prompt }]
  const promptTokens = estTokens(messages.map((x) => x.content).join('\n'))
  // How many output tokens the rest of the cap still pays for.
  const room = (cap - start) / YOCTO_PER_TOKEN - promptTokens
  if (room <= 0n) return send(res, 409, { code: 'CAP_REACHED', error: 'This session reached its spending cap. End it and open a new one to continue.' }, origin)

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', ...cors(origin) })
  const emit = (ev) => res.write(`${JSON.stringify(ev)}\n`)
  const upstream = new AbortController()
  let closed = false
  res.on('close', () => {
    if (!res.writableFinished) {
      closed = true
      upstream.abort()
    }
  })

  // Verify the enclave BEFORE the prompt leaves the gateway, in both modes.
  let attestation = null
  {
    try {
      attestation = await currentAttestation()
    } catch (e) {
      console.warn(`attestation failed: ${e.message}`)
    }
    if (LIVE_MODEL && !attestation?.verified) {
      emit({ type: 'error', code: 'GATEWAY_DOWN', message: 'NEAR AI Cloud attestation could not be verified, so your prompt was not sent. Nothing was charged.' })
      return res.end()
    }
  }

  let outTokens = 0n
  let text = ''
  let capHit = false
  let end = null
  let failed = null
  const overCap = () => start + (promptTokens + outTokens) * YOCTO_PER_TOKEN > cap
  try {
    if (LIVE_MODEL) {
      const maxTokens = Number(room < 1024n ? room : 1024n)
      for await (const ev of streamChat({ apiKey: NEARAI_API_KEY, messages, maxTokens, signal: upstream.signal })) {
        if (ev.type === 'end') {
          end = ev
          break
        }
        text += ev.text
        outTokens = estTokens(text)
        if (overCap()) {
          capHit = true
          upstream.abort()
          break
        }
        if (!closed) emit({ type: 'token', text: ev.text })
      }
    } else {
      await sleep(300)
      for (const part of answerFor(prompt).split(/(\s+)/)) {
        if (closed) break
        if (part.trim()) outTokens++
        if (overCap()) {
          capHit = true
          break
        }
        emit({ type: 'token', text: part })
        if (part.trim()) await sleep(15 + Math.random() * 25)
      }
    }
  } catch (e) {
    if (!closed && !capHit) failed = e
  }

  // Charge what was used (the provider's own count when it reports one), never above the cap.
  const used = end?.usage?.total_tokens ? BigInt(end.usage.total_tokens) : promptTokens + outTokens
  let cost = used * YOCTO_PER_TOKEN
  if (failed && outTokens === 0n) cost = 0n // nothing delivered, nothing charged
  if (start + cost > cap) cost = cap - start
  m.metered = (start + cost).toString()
  m.tokens += Number(cost / YOCTO_PER_TOKEN)
  m.requests += 1
  if (anon) notes.save()
  else persist()

  if (closed) return res.end()
  if (failed) {
    console.warn(`chat #${session_id} failed: ${failed.message}`)
    emit({ type: 'error', code: 'GATEWAY_DOWN', message: `The model provider failed (${failed.message}). ${cost > 0n ? 'You were charged only for what was delivered.' : 'Nothing was charged.'}` })
    return res.end()
  }
  if (capHit) {
    emit({ type: 'error', code: 'CAP_REACHED', message: 'This session reached its spending cap. End it and open a new one to continue.' })
    return res.end()
  }
  emit({ type: 'usage', tokens: Number(cost / YOCTO_PER_TOKEN), cost: cost.toString(), metered: m.metered })

  // Every chat gets the TEE evidence; a note-paid chat also gets its payment proof.
  if (anon) emit({ type: 'proof', proof: notes.proofFor(anon, attestation?.verified ?? null) })
  if (attestation) emit({ type: 'proof', proof: await responseProof(attestation, end) })
  emit({ type: 'done' })
  res.end()
}

/** The attestation plus, for a real reply, the provider's signature over this exact request and response. */
async function responseProof(attestation, end) {
  const proof = { ...attestation, raw: { ...attestation.raw, simulated_reply: !LIVE_MODEL } }
  if (!LIVE_MODEL) {
    proof.checks = [...attestation.checks, { name: 'Reply signed by this model', ok: false, detail: 'No NEAR AI Cloud API key on the gateway: this reply was simulated. The attestation above is real, for the model that would answer.' }]
    proof.verified = false
    return proof
  }
  try {
    if (!end?.id) throw new Error('the provider returned no completion id')
    const sig = await fetchSignatureRetry(end.id)
    const sigChecks = verifySignature(sig, {
      modelAddress: attestation.signing_key,
      gatewayAddress: attestation.raw.gateway_signing_address,
      requestBody: end.requestBody,
      responseBody: end.responseBody,
    })
    proof.checks = [...attestation.checks, ...sigChecks]
    proof.response_signature = { chat_id: end.id, kind: sig.signature_kind ?? null, text: sig.text, signature: sig.signature, signing_address: sig.signing_address }
  } catch (e) {
    proof.checks = [...attestation.checks, { name: 'Reply signed by this model', ok: false, detail: `Signature not available: ${e.message}` }]
  }
  proof.verified = proof.checks.every((c) => c.ok)
  return proof
}

async function fetchSignatureRetry(chatId) {
  let last
  for (let i = 0; i < 4; i++) {
    try {
      return await fetchSignature(chatId, NEARAI_MODEL, NEARAI_API_KEY)
    } catch (e) {
      last = e
      await sleep(500 * (i + 1))
    }
  }
  throw last
}

async function handleSettle(req, res, origin, sessionId) {
  const { account_id } = await readJson(req)
  let s
  try {
    s = await liveSession(sessionId, account_id, req)
  } catch (e) {
    return send(res, e.status ?? 502, { error: e.error ?? String(e.message ?? e) }, origin)
  }
  if (nowNs() > BigInt(s.settle_deadline)) return send(res, 409, { error: 'Settlement window has closed. Reclaim the session instead.' }, origin)
  const key = `chain:${sessionId}`
  if (busy.has(key)) return send(res, 409, { error: 'A reply is still in progress for this session. Stop it or wait, then end the session.' }, origin)
  busy.add(key) // no reply may start while the settlement is on its way
  try {
    const { spent, hash, result } = await settleMetered(sessionId, s)
    // The settle tx is final; reads can lag a block, so fall back to the values we just settled.
    const receipts = await gw.getReceipts(account_id).catch(() => [])
    const receipt = receipts.find((r) => r.session_id === String(sessionId)) ?? {
      session_id: String(sessionId),
      cap: s.cap,
      spent: spent.toString(),
      refunded: (BigInt(s.cap) - spent).toString(),
      receipt_hash: hash,
      closed_at: nowNs().toString(),
      outcome: 'Settled',
    }
    console.log(`settled #${sessionId} for ${account_id}: ${spent} yocto (tx ${result.tx})`)
    return send(res, 200, { receipt, tx: result.tx }, origin)
  } catch (e) {
    return send(res, 502, { error: `Settlement failed: ${e instanceof Error ? e.message : e}` }, origin)
  } finally {
    busy.delete(key)
  }
}

/** Settle an on-chain session at what the gateway metered (never above the cap) and forget it. */
async function settleMetered(sessionId, s) {
  const m = metering[sessionId] ?? { metered: '0', tokens: 0, requests: 0 }
  const spent = BigInt(m.metered) > BigInt(s.cap) ? BigInt(s.cap) : BigInt(m.metered)
  const record = { session_id: String(sessionId), account_id: s.owner, spent_yocto: spent.toString(), tokens: m.tokens, requests: m.requests, model: MODEL_ID, settled_at: new Date().toISOString() }
  const hash = receiptHash(record)
  const result = await gw.settleExact(sessionId, spent.toString(), hash)
  delete metering[sessionId]
  persist()
  delete sessionKeys[sessionId]
  persistKeys()
  return { spent, hash, result }
}

/**
 * Sessions the user never ended. Without this, someone could chat, let the session expire and
 * reclaim the full cap. Once a session with metered usage has expired, settle it ourselves while the
 * settlement window (15 minutes after expiry) is still open.
 */
async function sweep() {
  if (!cfg.gatewayId || !cfg.privateKey) return
  for (const id of Object.keys(metering)) {
    const key = `chain:${id}`
    if (busy.has(key)) continue
    busy.add(key)
    try {
      const s = await gw.getSession(id)
      if (!s) {
        // closed elsewhere (reclaimed, or settled from the CLI)
        delete metering[id]
        delete sessionKeys[id]
        persist()
        persistKeys()
      } else if (nowNs() > BigInt(s.expires_at) && nowNs() <= BigInt(s.settle_deadline)) {
        const { spent, result } = await settleMetered(id, s)
        console.log(`auto-settled expired #${id} for ${s.owner}: ${spent} yocto (tx ${result.tx})`)
      }
    } catch (e) {
      console.warn(`sweep #${id}: ${e instanceof Error ? e.message : e}`)
    } finally {
      busy.delete(key)
    }
  }
  notes.prune()
}
const SWEEP_MS = Number(process.env.SWEEP_MS || 60_000)
setInterval(() => void sweep(), SWEEP_MS).unref()


/** Turn a thrown error into a JSON reply (errors from notes.js are user-facing). */
async function reply(res, origin, fn, failStatus = 400) {
  try {
    return send(res, 200, await fn(), origin)
  } catch (e) {
    return send(res, failStatus, { error: e instanceof Error ? e.message : String(e), checks: e?.checks }, origin)
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
      return send(res, 200, { ok: true, contract: cfg.contractId, gateway: cfg.gatewayId ?? null, can_settle: !!(cfg.gatewayId && cfg.privateKey), model: MODEL_ID, model_live: LIVE_MODEL, attested_model: NEARAI_MODEL, attestation_verified: attestCache ? attestCache.value.verified : null }, origin)
    if (req.method === 'GET' && url.pathname === '/v1/metering') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
      return send(res, 200, Object.fromEntries(ids.map((id) => [id, metering[id]?.metered ?? notes.metered(id) ?? '0'])), origin)
    }
    if (req.method === 'GET' && url.pathname === '/v1/attestation') return send(res, 200, await currentAttestation(), origin)
    if (req.method === 'GET' && url.pathname === '/v1/notes') return send(res, 200, notes.info(), origin)
    if (req.method === 'POST' && url.pathname === '/v1/notes') {
      const b = await readJson(req)
      return await reply(res, origin, () => notes.register({ accountId: b.account_id, sessionId: b.session_id, txHash: b.tx }))
    }
    if (req.method === 'POST' && url.pathname === '/v1/anon/sessions') {
      const b = await readJson(req)
      return await reply(res, origin, () => notes.redeem({ proof: b.proof, clientKey: b.client_key }))
    }
    const anonClose = url.pathname.match(/^\/v1\/anon\/sessions\/([0-9a-f]{32})\/close$/)
    if (req.method === 'POST' && anonClose) {
      await readJson(req)
      return await reply(res, origin, () => {
        notes.auth(anonClose[1], req)
        notes.close(anonClose[1])
        return { closed: true }
      }, 401)
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat') return await handleChat(req, res, origin)
    const settle = url.pathname.match(/^\/v1\/sessions\/(\d+)\/settle$/)
    if (req.method === 'POST' && settle) return await handleSettle(req, res, origin, settle[1])
    send(res, 404, { error: 'Not found' }, origin)
  } catch (e) {
    if (!res.headersSent) send(res, e?.status ?? 500, { error: e instanceof Error ? e.message : String(e) }, origin)
    else res.end()
  }
})

server.listen(PORT, BIND, () => {
  console.log(`Nexora gateway on http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}`)
  console.log(`  contract ${cfg.contractId} via ${cfg.rpcUrl}`)
  console.log(`  settles as ${cfg.gatewayId ?? '(no GATEWAY_ACCOUNT_ID)'}${cfg.privateKey ? '' : '  (no GATEWAY_PRIVATE_KEY: chat works, settling will fail)'}`)
  console.log(`  model ${MODEL_ID}${LIVE_MODEL ? '' : `  (set NEARAI_API_KEY for real replies; attestation of ${NEARAI_MODEL} is still real)`}`)
})
