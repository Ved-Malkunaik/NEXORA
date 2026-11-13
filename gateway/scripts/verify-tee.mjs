#!/usr/bin/env node
// Independent check that NEAR AI Cloud runs the model in a TEE and signs its answers there.
// Uses none of Nexora's gateway code: only fetch, Node's crypto and @noble for signature recovery.
//
//   node --env-file=.env scripts/verify-tee.mjs        (NEARAI_API_KEY needed for step 4)
import { createHash, randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

const BASE = 'https://cloud-api.near.ai/v1'
const MODEL = process.env.NEARAI_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const line = (ok, text) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`)

// 1. Ask for an attestation with a nonce only we know.
const nonce = randomBytes(32).toString('hex')
const q = new URLSearchParams({ model: MODEL, provider: 'near', signing_algo: 'ecdsa', nonce, include_tls_fingerprint: 'false' })
const report = await (await fetch(`${BASE}/attestation/report?${q}`, { headers: { 'x-no-aliasing': 'true' } })).json()
const m = report.model_attestations.find((x) => x.model_name === MODEL)
console.log(`Model ${MODEL}\nOur nonce ${nonce}\nEnclave signing address ${m.signing_address}\n`)

// 2. Read the hardware quote ourselves (TDX v4: 48-byte header, report body after it).
const quote = Buffer.from(m.intel_quote, 'hex')
const reportData = quote.subarray(48 + 520, 48 + 584).toString('hex')
const mrtd = quote.subarray(48 + 136, 48 + 184).toString('hex')
const tcb = typeof m.info.tcb_info === 'string' ? JSON.parse(m.info.tcb_info) : m.info.tcb_info
line(m.request_nonce === nonce, 'NEAR AI answered our fresh nonce (not a replayed report)')
line(reportData === m.signing_address.slice(2).toLowerCase().padEnd(64, '0') + nonce, `quote report_data = signing address + our nonce\n      ${reportData}`)
line(mrtd === tcb.mrtd, `VM measurement (MRTD) in the quote = published tcb_info  ${mrtd.slice(0, 24)}…`)
line(quote.subarray(48 + 184, 48 + 232).toString('hex') === `01${sha256(tcb.app_compose)}`.padEnd(96, '0'), `MRCONFIGID = 01 + sha256(app_compose): the exact container config  ${tcb.compose_hash.slice(0, 24)}…`)

// 3. Is the quote genuinely from Intel TDX hardware, and the GPUs genuine NVIDIA in CC mode?
const dcap = await (await fetch('https://cloud-api.phala.network/api/v1/attestations/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex: m.intel_quote }) })).json()
line(dcap.quote?.verified === true, `Intel DCAP: quote signature chain to Intel verified (tee ${dcap.quote?.header?.tee_type})`)
const nras = await (await fetch('https://nras.attestation.nvidia.com/v3/attest/gpu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: m.nvidia_payload })).json()
const claims = JSON.parse(Buffer.from(nras[0][1].split('.')[1], 'base64url').toString())
line(claims['x-nvidia-overall-att-result'] === true && claims.eat_nonce === nonce, `NVIDIA NRAS: ${Object.keys(claims.submods).length} GPUs attested in confidential-computing mode, with our nonce`)

// 4. A real completion, and its signature recovered to the enclave's address.
if (!process.env.NEARAI_API_KEY) {
  console.log('\n(no NEARAI_API_KEY: skipping the signed-reply check)')
  process.exit(0)
}
const requestBody = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: hello from the enclave' }], max_tokens: 20 })
const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.NEARAI_API_KEY}`, 'x-no-aliasing': 'true' }, body: requestBody })
const responseBody = await res.text()
const completion = JSON.parse(responseBody)
console.log(`\nReply: "${completion.choices[0].message.content.trim()}"  (id ${completion.id})`)
let sig
for (let i = 0; i < 5 && !sig?.signature; i++) {
  await new Promise((r) => setTimeout(r, 800))
  sig = await (await fetch(`${BASE}/signature/${completion.id}?model=${encodeURIComponent(MODEL)}&signing_algo=ecdsa`, { headers: { Authorization: `Bearer ${process.env.NEARAI_API_KEY}` } })).json()
}
const raw = Buffer.from(sig.signature.slice(2), 'hex')
const msg = Buffer.from(sig.text)
const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]))
const pub = secp256k1.recoverPublicKey(Buffer.concat([Buffer.from([raw[64] >= 27 ? raw[64] - 27 : raw[64]]), raw.subarray(0, 64)]), digest, { prehash: false })
const signer = `0x${Buffer.from(keccak_256(secp256k1.Point.fromBytes(pub).toBytes(false).subarray(1))).subarray(12).toString('hex')}`
const [reqHash, resHash] = sig.text.split(':').slice(-2)
console.log(`Signature kind: ${sig.signature_kind ?? 'n/a'}\nSigned text: ${sig.text}`)
line(signer.toLowerCase() === m.signing_address.toLowerCase(), `signature recovers to the attested enclave address ${signer}`)
line(reqHash === sha256(requestBody), 'signed request hash = sha256 of the exact bytes we sent')
line(resHash === sha256(responseBody), 'signed response hash = sha256 of the exact bytes we received')
