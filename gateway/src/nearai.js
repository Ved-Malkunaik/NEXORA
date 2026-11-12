// NEAR AI Cloud: private inference in a TEE, plus the evidence that it really ran there.
//
//   fetchAttestation(model, nonce)   GET /v1/attestation/report (public, no API key for public models)
//   verifyAttestation(report, nonce) checks we run ourselves + Intel DCAP + NVIDIA NRAS
//   streamChat(...)                  POST /v1/chat/completions (stream), needs NEARAI_API_KEY
//   fetchSignature / verifySignature per-response ECDSA signature from the attested signing key
//
// What "verified" means here is spelled out per check, so the UI can show exactly what passed.
import { createHash, randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

export const NEARAI_BASE = process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1'
/** A model NEAR runs itself inside a TEE (GPU + CPU attestation). Override with NEARAI_MODEL. */
export const NEARAI_MODEL = process.env.NEARAI_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
const DCAP_VERIFIER = process.env.DCAP_VERIFIER_URL || 'https://cloud-api.phala.network/api/v1/attestations/verify'
const NRAS_URL = process.env.NRAS_URL || 'https://nras.attestation.nvidia.com/v3/attest/gpu'
const REMOTE_VERIFY = process.env.ATTEST_REMOTE_VERIFY !== '0'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const strip0x = (h) => String(h ?? '').replace(/^0x/i, '').toLowerCase()

export const newNonce = () => randomBytes(32).toString('hex')

async function getJson(url, init, timeoutMs = 20_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

export async function fetchAttestation(model = NEARAI_MODEL, nonce = newNonce(), apiKey = process.env.NEARAI_API_KEY) {
  const q = new URLSearchParams({ model, provider: 'near', signing_algo: 'ecdsa', nonce, include_tls_fingerprint: 'false' })
  const headers = { Accept: 'application/json', 'x-no-aliasing': 'true' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return getJson(`${NEARAI_BASE}/attestation/report?${q}`, { headers })
}

// ---- TDX quote layout (v4): 48-byte header, then the 584-byte TD report body ----
const Q_MRTD = [48 + 136, 48 + 184]
const Q_MRCONFIG = [48 + 184, 48 + 232]
const Q_REPORT_DATA = [48 + 520, 48 + 584]

/** Pull the fields we check out of a raw TDX quote. Exported for tests. */
export function parseTdxQuote(hex) {
  const q = Buffer.from(strip0x(hex), 'hex')
  if (q.length < Q_REPORT_DATA[1]) throw new Error('TDX quote too short')
  const version = q.readUInt16LE(0)
  const teeType = q.readUInt32LE(4)
  if (version !== 4 || teeType !== 0x81) throw new Error(`Not a TDX v4 quote (version ${version}, tee 0x${teeType.toString(16)})`)
  const slice = ([a, b]) => q.subarray(a, b).toString('hex')
  return { mrtd: slice(Q_MRTD), mrconfig: slice(Q_MRCONFIG), report_data: slice(Q_REPORT_DATA) }
}

function tcbInfo(info) {
  const t = info?.tcb_info
  return typeof t === 'string' ? JSON.parse(t) : (t ?? {})
}

/**
 * Local checks: these need nothing but the report itself.
 *  - the report answers OUR fresh nonce (no replay)
 *  - the quote's report_data binds the signing address + our nonce (the key that signs replies lives in this TEE)
 *  - the quote's MRTD matches the claimed tcb_info, and MRCONFIGID = 0x01 || sha256(app_compose) (the code that runs)
 */
export function localChecks(m, nonce) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })
  add('Fresh nonce', strip0x(m.request_nonce) === nonce, 'The report answers the random nonce the gateway just sent')
  let q
  try {
    q = parseTdxQuote(m.intel_quote)
  } catch (e) {
    add('TDX quote parses', false, String(e.message))
    return checks
  }
  const addr = strip0x(m.signing_address)
  const expected = addr.padEnd(64, '0') + nonce
  add('Signing key bound to quote', q.report_data === expected, 'report_data = signing address ‖ nonce, inside the hardware-signed quote')
  const tcb = tcbInfo(m.info)
  add('MRTD matches', !!tcb.mrtd && q.mrtd === strip0x(tcb.mrtd), 'VM measurement in the quote equals the published tcb_info')
  const compose = tcb.app_compose
  const composeHash = compose ? sha256(compose) : ''
  add(
    'App config matches',
    !!compose && q.mrconfig === `01${composeHash}`.padEnd(96, '0'),
    'MRCONFIGID commits to sha256(app_compose): the exact container config running the model',
  )
  return checks
}

/** Intel DCAP: is the quote genuinely signed by Intel TDX hardware with a current TCB? */
async function dcapCheck(quoteHex) {
  const r = await getJson(DCAP_VERIFIER, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex: strip0x(quoteHex) }) })
  return { ok: r?.quote?.verified === true, detail: `Intel TDX quote signature checked by DCAP (${new URL(DCAP_VERIFIER).host})` }
}

/** NVIDIA NRAS: are the GPUs genuine H100/H200/B200 in confidential-computing mode, answering our nonce? */
async function gpuCheck(payloadStr, nonce) {
  const r = await getJson(NRAS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payloadStr })
  const jwt = Array.isArray(r) ? r.find((x) => x?.[0] === 'JWT')?.[1] : null
  if (!jwt) return { ok: false, detail: 'NVIDIA NRAS returned no token' }
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
  const gpus = Object.keys(claims.submods ?? {}).length
  return {
    ok: claims['x-nvidia-overall-att-result'] === true && strip0x(claims.eat_nonce) === nonce,
    detail: `NVIDIA attestation service: ${gpus} GPU${gpus === 1 ? '' : 's'} in confidential-computing mode, same nonce`,
  }
}

/**
 * Fetch and verify the model's attestation. Returns a TeeAttestation (src/client/types.ts) with a
 * `checks` list; `verified` is true only if every check passed.
 */
export async function attest(model = NEARAI_MODEL) {
  const nonce = newNonce()
  const report = await fetchAttestation(model, nonce)
  const m = (report.model_attestations ?? []).find((x) => x.model_name === model) ?? report.model_attestations?.[0]
  if (!m) throw new Error(`NEAR AI Cloud returned no model attestation for ${model}`)
  const checks = localChecks(m, nonce)
  if (REMOTE_VERIFY) {
    const remote = await Promise.allSettled([dcapCheck(m.intel_quote), m.nvidia_payload ? gpuCheck(m.nvidia_payload, nonce) : Promise.resolve(null)])
    const [dcap, gpu] = remote
    checks.push(dcap.status === 'fulfilled' ? { name: 'Intel TDX quote genuine', ...dcap.value } : { name: 'Intel TDX quote genuine', ok: false, detail: `Verifier unreachable: ${dcap.reason?.message}` })
    if (gpu.status === 'rejected') checks.push({ name: 'NVIDIA GPU TEE', ok: false, detail: `NRAS unreachable: ${gpu.reason?.message}` })
    else if (gpu.value) checks.push({ name: 'NVIDIA GPU TEE', ...gpu.value })
  }
  const tcb = tcbInfo(m.info)
  return {
    kind: 'tee',
    provider: 'NEAR AI Cloud',
    model,
    hardware: m.nvidia_payload ? 'Intel TDX + NVIDIA GPU (confidential computing)' : 'Intel TDX',
    measurement: strip0x(tcb.mrtd),
    signing_key: m.signing_address,
    nonce,
    issued_at: Date.now(),
    verified: checks.every((c) => c.ok),
    verify_url: 'https://docs.near.ai/cloud/verification',
    checks,
    raw: {
      app_name: m.info?.app_name,
      compose_hash: tcb.compose_hash,
      os_image_hash: tcb.os_image_hash,
      rtmr3: tcb.rtmr3,
      signing_algo: m.signing_algo,
      gateway_signing_address: report.gateway_attestation?.signing_address,
      intel_quote: m.intel_quote,
    },
  }
}

// ---------- chat ----------

/**
 * Stream a chat completion. Yields {type:'delta', text} and finally {type:'end', id, usage, requestBody, responseBody}.
 * requestBody/responseBody are the exact bytes, so we can check them against the signed hashes.
 */
export async function* streamChat({ apiKey, model = NEARAI_MODEL, messages, maxTokens = 1024, signal }) {
  const requestBody = JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, stream_options: { include_usage: true } })
  const res = await fetch(`${NEARAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'x-no-aliasing': 'true' },
    body: requestBody,
    signal,
  })
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '')
    throw new Error(`NEAR AI Cloud ${res.status}: ${t.slice(0, 200)}`)
  }
  const dec = new TextDecoder()
  let raw = ''
  let buf = ''
  let id = null
  let usage = null
  for await (const chunk of res.body) {
    const s = dec.decode(chunk, { stream: true })
    raw += s
    buf += s
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let ev
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      id ??= ev.id
      if (ev.usage) usage = ev.usage
      const text = ev.choices?.[0]?.delta?.content
      if (text) yield { type: 'delta', text }
    }
  }
  yield { type: 'end', id, usage, requestBody, responseBody: raw }
}

export async function fetchSignature(chatId, model = NEARAI_MODEL, apiKey = process.env.NEARAI_API_KEY) {
  const q = new URLSearchParams({ model, signing_algo: 'ecdsa' })
  return getJson(`${NEARAI_BASE}/signature/${encodeURIComponent(chatId)}?${q}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
  })
}

/** Ethereum-style address of the key that signed `text` (EIP-191 personal_sign). Exported for tests. */
export function recoverAddress(text, sigHex) {
  const sig = Buffer.from(strip0x(sigHex), 'hex')
  if (sig.length !== 65) throw new Error('Expected a 65-byte signature')
  const msg = Buffer.from(text, 'utf8')
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]))
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64]
  // noble's 'recovered' format is recovery-byte first: [v, r, s]
  const recovered = Buffer.concat([Buffer.from([v]), sig.subarray(0, 64)])
  const pub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false })
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false)
  return `0x${Buffer.from(keccak_256(uncompressed.subarray(1))).subarray(12).toString('hex')}`
}

/**
 * Check a response signature: it was made by the attested signing key, over the hashes of the
 * exact request we sent and the exact response we received.
 */
export function verifySignature(sig, { modelAddress, gatewayAddress, requestBody, responseBody }) {
  // provider_tee: signed by the model's TEE key. gateway: signed by NEAR AI's attested gateway key.
  const attestedAddress = sig.signature_kind === 'gateway' ? gatewayAddress : modelAddress
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })
  let signer = null
  try {
    signer = recoverAddress(sig.text, sig.signature)
  } catch (e) {
    add('Signature valid', false, String(e.message))
    return checks
  }
  const fromTee = strip0x(signer) === strip0x(attestedAddress)
  add('Signed by the attested key', fromTee, `${sig.signature_kind === 'gateway' ? 'NEAR AI gateway' : 'Model TEE'} key ${signer}`)
  const parts = String(sig.text).split(':')
  const [reqHash, resHash] = parts.slice(-2)
  add('Request hash matches', reqHash === sha256(requestBody), 'sha256 of the exact request the gateway sent')
  add('Response hash matches', resHash === sha256(responseBody), 'sha256 of the exact stream the gateway received')
  return checks
}
