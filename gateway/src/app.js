// Nexora gateway: the only account allowed to settle sessions on the credits contract.
// This module is the whole gateway as a request handler, so it runs the same way under the local
// Node server (server.js) and as a Vercel Function (api/gateway.js). All state lives in `store`.
//
//   POST /v1/chat                      stream a reply (NDJSON), metered against the session's cap
//   GET  /v1/metering?ids=1,2          metered spend per open session
//   POST /v1/sessions/:id/settle       settle_session on-chain with the gateway's own metered total
//   GET  /v1/notes                     notes: public list of paid note commitments, price, scope
//   POST /v1/notes                     notes: buy a note (public; settles the purchase session)
//   POST /v1/anon/sessions             notes: spend a note with a zero-knowledge proof (anonymous)
//   POST /v1/anon/sessions/:id/close   notes: drop an anonymous session
//   GET  /v1/attestation               TEE mode only: fresh, verified NEAR AI Cloud attestation
//   GET  /v1/sweep                     settle expired sessions now (also runs on its own)
//   GET  /v1/health                    configuration and usage
//
// The browser never tells the gateway how much to charge: cost is metered here, per token.
// Prompts and replies are not stored; only per-session token counts and cost.
// Model provider (MODEL_PROVIDER, or picked from whichever key is set):
//   openrouter  free open models via OpenRouter. NOT private: OpenRouter and the model host see prompts.
//   nearai      NEAR AI Cloud in a TEE; prompts are sent only after its attestation verifies.
//   simulated   no key: canned replies, labelled as such.
//
// Callers are authenticated per session: each chat/settle request is signed by the session's chat key,
// whose public key the owner registered on-chain in open_session (auth.js).
import { AUTH_WINDOW_MS, clientKeyFromOpenTx, verifyRequest } from './auth.js'
import { MOCK_MODEL_ID, answerFor } from './model.js'
import { NEARAI_MODEL, attest, fetchSignature, streamChat, verifySignature } from './nearai.js'
import { createNotes } from './notes.js'
import { UpstreamError, createLimiter, openRouterModels, streamOpenRouter } from './openrouter.js'
import { createGateway, readConfig, receiptHash } from './settlement.js'

/** Same price as the UI shows: 0.00002 NEAR per token. */
export const YOCTO_PER_TOKEN = 20_000_000_000_000_000_000n

const SYSTEM_PROMPT = 'You are Nexora, a private assistant. Answer clearly and concisely.'
const LOCK_MS = 5 * 60_000 // longest a reply can stream (Vercel's limit on the free plan)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowNs = () => BigInt(Date.now()) * 1_000_000n
const estTokens = (text) => BigInt(Math.ceil(text.length / 4))

// Store keys
const K = {
  meter: (id) => `meter:${id}`, // { metered, tokens, mode, requests } per open on-chain session
  meterIds: 'meter:ids',
  chatKey: (id) => `chatkey:${id}`, // the session's chat public key (public data)
  sig: (s) => `sig:${s}`, // replay markers
  lock: (k) => `lock:${k}`, // one request per session at a time
  sweep: 'lock:sweep',
}

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

/**
 * @param {object} o
 * @param {object} o.store   see store.js
 * @param {object} [o.env]   process.env by default
 */
export function createApp({ store, env = process.env, log = console }) {
  const NEARAI_API_KEY = env.NEARAI_API_KEY || ''
  const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY || ''
  const PROVIDER = (env.MODEL_PROVIDER || (OPENROUTER_API_KEY ? 'openrouter' : NEARAI_API_KEY ? 'nearai' : 'simulated')).toLowerCase()
  if (!['openrouter', 'nearai', 'simulated'].includes(PROVIDER)) throw new Error(`MODEL_PROVIDER must be openrouter, nearai or simulated (got ${PROVIDER})`)
  /** Real replies from a real model. */
  const LIVE_MODEL = PROVIDER === 'openrouter' ? !!OPENROUTER_API_KEY : PROVIDER === 'nearai' ? !!NEARAI_API_KEY : false
  /** Prompts run in an attested TEE. Only NEAR AI Cloud provides that. */
  const TEE = PROVIDER === 'nearai'
  const OR_MODELS = openRouterModels(env)
  const MODEL_ID = !LIVE_MODEL ? MOCK_MODEL_ID : PROVIDER === 'openrouter' ? OR_MODELS[0] : NEARAI_MODEL
  const OR_DATA_COLLECTION = env.OPENROUTER_DATA_COLLECTION === 'deny' ? 'deny' : 'allow'
  /** Browser origins allowed to call a gateway on another origin. Same-origin (Vercel) needs none. */
  const ORIGINS = (env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((s) => s.trim()).filter(Boolean)
  /** Set REQUIRE_AUTH=0 only for local experiments: anyone could then spend or settle any session. */
  const REQUIRE_AUTH = env.REQUIRE_AUTH !== '0'
  const SWEEP_MS = Number(env.SWEEP_MS || 60_000)

  const cfg = readConfig(env)
  const gw = createGateway(cfg)
  const limiter = createLimiter({ store, perMinute: Number(env.OPENROUTER_RPM || 18), perDay: Number(env.OPENROUTER_RPD || 1000) })
  /** Private-payment notes: one fixed price so every note looks the same. Default 0.02 NEAR = 1000 tokens. */
  const notes = createNotes({
    store,
    priceYocto: env.NOTE_PRICE_YOCTO || '20000000000000000000000',
    yoctoPerToken: YOCTO_PER_TOKEN,
    chain: { rpcUrl: cfg.rpcUrl, contractId: cfg.contractId, getSession: gw.getSession, settleExact: gw.settleExact },
  })

  function cors(origin) {
    return origin && ORIGINS.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Nexora-Ts, X-Nexora-Sig, X-Nexora-Open-Tx', Vary: 'Origin' }
      : {}
  }
  function send(res, status, body, origin) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) })
    res.end(JSON.stringify(body))
  }

  /** One request per session at a time, across all instances. Returns a release function, or null. */
  async function lock(key) {
    if (!(await store.set(K.lock(key), Date.now(), { nx: true, px: LOCK_MS }))) return null
    return () => store.del(K.lock(key))
  }

  async function getMeter(id) {
    return (await store.get(K.meter(id))) ?? { metered: '0', tokens: 0, mode: 'B', requests: 0 }
  }
  async function putMeter(id, m) {
    await store.set(K.meter(id), m)
    await store.sadd(K.meterIds, id)
  }
  async function forgetSession(id) {
    await store.del(K.meter(id))
    await store.srem(K.meterIds, id)
    await store.del(K.chatKey(id))
  }

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
      let pub = await store.get(K.chatKey(sessionId))
      if (!pub) {
        pub = await clientKeyFromOpenTx({ rpcUrl: cfg.rpcUrl, contractId: cfg.contractId, txHash: req.headers['x-nexora-open-tx'], owner: s.owner, sessionId })
        await store.set(K.chatKey(sessionId), pub)
      }
      const path = new URL(req.url ?? '/', 'http://gateway').pathname
      const sigHex = req.headers['x-nexora-sig']
      verifyRequest({ publicKeyHex: pub, method: req.method, path, sessionId: String(sessionId), ts: req.headers['x-nexora-ts'], sigHex, body: req.rawBody ?? '' })
      // Replay protection: each signature is accepted once.
      if (!(await store.set(K.sig(sigHex), 1, { nx: true, px: AUTH_WINDOW_MS * 2 }))) throw new Error('This request was already used')
    } catch (e) {
      throw { status: 401, code: 'SESSION_CLOSED', error: `Not authorised for this session: ${e.message}` }
    }
    return s
  }

  // ---------- TEE mode: attestation (kept per instance; it is re-fetched every 10 minutes) ----------
  const ATTEST_TTL_MS = Number(env.ATTEST_TTL_MS || 10 * 60_000)
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

  // ---------- chat ----------

  async function handleChat(req, res, origin) {
    const body = await readJson(req)
    const key = body.anon_session !== undefined ? `anon:${body.anon_session}` : `chain:${body.session_id}`
    const release = await lock(key)
    if (!release) return send(res, 409, { code: 'GATEWAY_DOWN', error: 'A reply is already in progress for this session. Wait for it to finish.' }, origin)
    try {
      return await chatLocked(req, res, origin)
    } finally {
      await release()
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
        anon = await notes.auth(anon_session, req)
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
      // An on-chain session is internally mode 'B'; a note-paid session is the anonymous path above.
      m = { ...(await getMeter(session_id)), mode: 'B' }
    }
    if (nowNs() > BigInt(s.expires_at)) return send(res, 409, { code: 'SESSION_EXPIRED', error: 'This session has expired. End it to settle, or open a new one.' }, origin)

    const cap = BigInt(s.cap)
    const start = BigInt(m.metered)
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...cleanHistory(history), { role: 'user', content: prompt }]
    const promptTokens = estTokens(messages.map((x) => x.content).join('\n'))
    // How many output tokens the rest of the cap still pays for.
    const room = (cap - start) / YOCTO_PER_TOKEN - promptTokens
    if (room <= 0n) return send(res, 409, { code: 'CAP_REACHED', error: 'This session reached its spending cap. End it and open a new one to continue.' }, origin)

    if (PROVIDER === 'openrouter' && LIVE_MODEL) {
      const busy = await limiter.take()
      if (busy) return send(res, 429, { code: 'GATEWAY_DOWN', error: busy }, origin)
    }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', ...cors(origin) })
    const emit = (ev) => res.write(`${JSON.stringify(ev)}\n`)
    const upstream = new AbortController()
    let closed = false
    res.on('close', () => {
      if (!res.writableFinished) {
        closed = true
        upstream.abort()
      }
    })

    // NEAR AI Cloud: verify the enclave BEFORE the prompt leaves the gateway, however the session is paid.
    let attestation = null
    if (TEE) {
      try {
        attestation = await currentAttestation()
      } catch (e) {
        log.warn(`attestation failed: ${e.message}`)
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
        const stream =
          PROVIDER === 'openrouter'
            ? streamOpenRouter({ apiKey: OPENROUTER_API_KEY, models: OR_MODELS, messages, maxTokens, signal: upstream.signal, siteUrl: env.PUBLIC_URL || ORIGINS[0], dataCollection: OR_DATA_COLLECTION })
            : streamChat({ apiKey: NEARAI_API_KEY, messages, maxTokens, signal: upstream.signal })
        for await (const ev of stream) {
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

    // A real model that finished without any visible text (e.g. it spent its whole allowance reasoning).
    if (LIVE_MODEL && !failed && !capHit && !closed && !text.trim())
      failed = new UpstreamError('The model returned no text. If this session is near its cap, open a new one; otherwise try again.')

    // Charge what was used (the provider's own count when it reports one), never above the cap.
    const used = end?.usage?.total_tokens ? BigInt(end.usage.total_tokens) : promptTokens + outTokens
    let cost = used * YOCTO_PER_TOKEN
    if (failed && outTokens === 0n) cost = 0n // nothing delivered, nothing charged
    if (start + cost > cap) cost = cap - start
    m.metered = (start + cost).toString()
    m.tokens += Number(cost / YOCTO_PER_TOKEN)
    m.requests += 1
    if (anon) await notes.saveSession(anon_session, m)
    else await putMeter(session_id, m)

    if (closed) return res.end()
    if (failed) {
      log.warn(`chat #${session_id} failed: ${failed.message}`)
      const why = failed instanceof UpstreamError ? failed.message : `The model provider failed (${failed.message}).`
      emit({ type: 'error', code: 'GATEWAY_DOWN', message: `${why} ${cost > 0n ? 'You were charged only for what was delivered.' : 'Nothing was charged.'}` })
      return res.end()
    }
    if (capHit) {
      emit({ type: 'error', code: 'CAP_REACHED', message: 'This session reached its spending cap. End it and open a new one to continue.' })
      return res.end()
    }
    emit({ type: 'usage', tokens: Number(cost / YOCTO_PER_TOKEN), cost: cost.toString(), metered: m.metered })

    // A note-paid chat gets its payment proof; every chat says where the model ran.
    if (anon) emit({ type: 'proof', proof: notes.proofFor(anon, attestation?.verified ?? null) })
    if (attestation) emit({ type: 'proof', proof: await responseProof(attestation, end) })
    else if (!TEE) emit({ type: 'proof', proof: routeInfo(end) })
    emit({ type: 'done' })
    res.end()
  }

  /** Where a reply came from when there is no TEE: stated plainly, nothing to verify. */
  function routeInfo(end) {
    const live = LIVE_MODEL && PROVIDER === 'openrouter'
    return {
      kind: 'route',
      provider: live ? 'OpenRouter' : 'Simulated',
      model: end?.model ?? MODEL_ID,
      host: end?.provider ?? null,
      tee: false,
      issued_at: Date.now(),
      note: live
        ? 'Not private inference: OpenRouter and the company running this model can read the prompt, and free models may log it or train on it. No account name was sent with it.'
        : 'No model ran: the gateway has no model API key, so this reply was simulated.',
      raw: { request_id: end?.id ?? null, data_collection: live ? OR_DATA_COLLECTION : null },
    }
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
      let sig
      let last
      for (let i = 0; i < 4 && !sig; i++) {
        try {
          sig = await fetchSignature(end.id, NEARAI_MODEL, NEARAI_API_KEY)
        } catch (e) {
          last = e
          await sleep(500 * (i + 1))
        }
      }
      if (!sig) throw last
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

  // ---------- settlement ----------

  /** Settle an on-chain session at what the gateway metered (never above the cap) and forget it. */
  async function settleMetered(sessionId, s) {
    const m = await getMeter(sessionId)
    const spent = BigInt(m.metered) > BigInt(s.cap) ? BigInt(s.cap) : BigInt(m.metered)
    const record = { session_id: String(sessionId), account_id: s.owner, spent_yocto: spent.toString(), tokens: m.tokens, requests: m.requests, model: MODEL_ID, settled_at: new Date().toISOString() }
    const hash = receiptHash(record)
    const result = await gw.settleExact(sessionId, spent.toString(), hash)
    await forgetSession(sessionId)
    return { spent, hash, result }
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
    const release = await lock(`chain:${sessionId}`) // no reply may start while the settlement is on its way
    if (!release) return send(res, 409, { error: 'A reply is still in progress for this session. Stop it or wait, then end the session.' }, origin)
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
      log.log(`settled #${sessionId} for ${account_id}: ${spent} yocto (tx ${result.tx})`)
      return send(res, 200, { receipt, tx: result.tx }, origin)
    } catch (e) {
      return send(res, 502, { error: `Settlement failed: ${e instanceof Error ? e.message : e}` }, origin)
    } finally {
      await release()
    }
  }

  /**
   * Sessions the user never ended. Without this, someone could chat, let the session expire and
   * reclaim the full cap. Once a session with metered usage has expired, settle it ourselves while the
   * settlement window (15 minutes after expiry) is still open. Runs at most once per SWEEP_MS across
   * all instances.
   */
  async function sweep({ force = false } = {}) {
    if (!cfg.gatewayId || !cfg.privateKey) return { settled: 0 }
    if (!(await store.set(K.sweep, Date.now(), { nx: true, px: force ? 5_000 : SWEEP_MS }))) return { settled: 0, skipped: true }
    let settled = 0
    for (const id of await store.smembers(K.meterIds)) {
      const release = await lock(`chain:${id}`)
      if (!release) continue
      try {
        const s = await gw.getSession(id)
        if (!s) await forgetSession(id) // closed elsewhere (reclaimed, or settled from the CLI)
        else if (nowNs() > BigInt(s.expires_at) && nowNs() <= BigInt(s.settle_deadline)) {
          const { spent, result } = await settleMetered(id, s)
          settled++
          log.log(`auto-settled expired #${id} for ${s.owner}: ${spent} yocto (tx ${result.tx})`)
        }
      } catch (e) {
        log.warn(`sweep #${id}: ${e instanceof Error ? e.message : e}`)
      } finally {
        await release()
      }
    }
    return { settled }
  }

  /** Turn a thrown error into a JSON reply (errors from notes.js are user-facing). */
  async function reply(res, origin, fn, failStatus = 400) {
    try {
      return send(res, 200, await fn(), origin)
    } catch (e) {
      return send(res, failStatus, { error: e instanceof Error ? e.message : String(e), checks: e?.checks }, origin)
    }
  }

  async function health() {
    return {
      ok: true,
      contract: cfg.contractId,
      gateway: cfg.gatewayId ?? null,
      can_settle: !!(cfg.gatewayId && cfg.privateKey),
      model: MODEL_ID,
      model_live: LIVE_MODEL,
      provider: PROVIDER,
      tee: TEE,
      storage: store.kind,
      ...(PROVIDER === 'openrouter' ? { models: OR_MODELS, limits: await limiter.stats() } : {}),
      ...(TEE ? { attested_model: NEARAI_MODEL, attestation_verified: attestCache ? attestCache.value.verified : null } : {}),
    }
  }

  /** Handle one HTTP request. `req.url` must be the gateway path (e.g. /v1/chat?x=1). */
  async function handle(req, res) {
    const origin = req.headers.origin
    const url = new URL(req.url ?? '/', 'http://gateway')
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors(origin))
        return res.end()
      }
      if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, await health(), origin)
      if (req.method === 'GET' && url.pathname === '/v1/metering') {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 20)
        const out = {}
        for (const id of ids) out[id] = /^\d+$/.test(id) ? (await store.get(K.meter(id)))?.metered ?? '0' : ((await notes.metered(id)) ?? '0')
        return send(res, 200, out, origin)
      }
      if (req.method === 'GET' && url.pathname === '/v1/sweep') return send(res, 200, await sweep({ force: true }), origin)
      if (req.method === 'GET' && url.pathname === '/v1/attestation') {
        if (!TEE) return send(res, 404, { error: 'This gateway does not run in a TEE (MODEL_PROVIDER is not nearai).' }, origin)
        return send(res, 200, await currentAttestation(), origin)
      }
      if (req.method === 'GET' && url.pathname === '/v1/notes') return send(res, 200, await notes.info(), origin)
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
        return await reply(
          res,
          origin,
          async () => {
            await notes.auth(anonClose[1], req)
            await notes.close(anonClose[1])
            return { closed: true }
          },
          401,
        )
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat') return await handleChat(req, res, origin)
      const settle = url.pathname.match(/^\/v1\/sessions\/(\d+)\/settle$/)
      if (req.method === 'POST' && settle) return await handleSettle(req, res, origin, settle[1])
      send(res, 404, { error: 'Not found' }, origin)
    } catch (e) {
      if (!res.headersSent) send(res, e?.status ?? 500, { error: e instanceof Error ? e.message : String(e) }, origin)
      else res.end()
    }
  }

  function describe() {
    return [
      `contract ${cfg.contractId} via ${cfg.rpcUrl}`,
      `settles as ${cfg.gatewayId ?? '(no GATEWAY_ACCOUNT_ID)'}${cfg.privateKey ? '' : '  (no GATEWAY_PRIVATE_KEY: chat works, settling will fail)'}`,
      `provider ${PROVIDER}${TEE ? ' (TEE, attested)' : ' (no TEE)'}: ${PROVIDER === 'openrouter' && LIVE_MODEL ? OR_MODELS.join(', ') : MODEL_ID}`,
      `storage ${store.kind}`,
      ...(LIVE_MODEL ? [] : ['no model API key: replies are simulated. Set OPENROUTER_API_KEY (or NEARAI_API_KEY)']),
    ]
  }

  return { handle, sweep, describe, SWEEP_MS }
}
