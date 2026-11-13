#!/usr/bin/env node
// Testnet smoke test of the full session flow against a running gateway, without the browser.
//
//   node scripts/smoke.mjs <owner.testnet> [gateway_url]
//
// Needs near-cli-rs with <owner>'s key in the system keychain (it signs open_session). Opens a
// 0.005 NEAR session with a fresh chat key, then checks: unsigned and forged requests are rejected,
// a signed chat streams and returns an attestation, a replayed request is rejected, and the
// session settles on-chain with a receipt.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Group, Identity, generateProof } from '@semaphore-protocol/core'
import { NOTE_SCOPE, keyMessage } from '../src/notes.js'
import { readConfig } from '../src/settlement.js'

const [owner, GW = 'http://localhost:8787'] = process.argv.slice(2)
if (!owner) {
  console.error('Usage: node scripts/smoke.mjs <owner.testnet> [gateway_url]')
  process.exit(2)
}
const { contractId } = readConfig()
const hex = (b) => Buffer.from(b).toString('hex')
const sk = ed25519.utils.randomSecretKey()
const pub = hex(ed25519.getPublicKey(sk))

function sign(method, path, sessionId, body) {
  const ts = String(Date.now())
  const msg = `nexora-auth-v1\n${method} ${path}\n${sessionId}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`
  return { 'X-Nexora-Ts': ts, 'X-Nexora-Sig': hex(ed25519.sign(new TextEncoder().encode(msg), sk)) }
}

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/** near-cli-rs binary. On Windows the npm shim is a .cmd that execFile cannot run, so use the real exe. */
function nearCli() {
  if (process.env.NEAR_CLI) return process.env.NEAR_CLI
  const winExe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'near-cli-rs', 'node_modules', '.bin_real', 'near.exe')
  return process.platform === 'win32' && existsSync(winExe) ? winExe : 'near'
}

/** Call open_session as `owner` with the keychain key. Returns the new session id and the tx hash. */
function openSession(args) {
  const cli = spawnSync(
    nearCli(),
    ['contract', 'call-function', 'as-transaction', contractId, 'open_session', 'json-args', JSON.stringify(args), 'prepaid-gas', '30 Tgas', 'attached-deposit', '0 NEAR', 'sign-as', owner, 'network-config', 'testnet', 'sign-with-keychain', 'send'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  // near-cli-rs prints the return value to stdout and the transaction details to stderr.
  const out = `${cli.stdout ?? ''}\n${cli.stderr ?? ''}`
  return { sessionId: out.match(/^"(\d+)"\s*$/m)?.[1], tx: out.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1] }
}

console.log(`Credits-paid chat: opening a session on ${contractId} as ${owner}…`)
const { sessionId, tx } = openSession({ cap: '5000000000000000000000', ttl_seconds: '600', client_key: `ed25519:${pub}` })
check('open_session returned an id and tx', !!sessionId && !!tx, `session ${sessionId}, tx ${tx}`)
if (!sessionId || !tx) process.exit(1)

const chatBody = JSON.stringify({ session_id: sessionId, account_id: owner, mode: 'B', prompt: 'In one sentence: what is a TEE?' })
// One retry: after a long pause the client may reuse a connection the gateway has already closed.
const post = async (path, body, headers = {}) => {
  const go = () => fetch(`${GW}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers }, body })
  try {
    return await go()
  } catch {
    return go()
  }
}

let r = await post('/v1/chat', chatBody)
check('unsigned chat rejected', r.status === 401, String(r.status))

const forged = { ...sign('POST', '/v1/chat', sessionId, chatBody), 'X-Nexora-Open-Tx': tx }
forged['X-Nexora-Sig'] = hex(ed25519.sign(new TextEncoder().encode('something else'), ed25519.utils.randomSecretKey()))
r = await post('/v1/chat', chatBody, forged)
check('forged signature rejected', r.status === 401, String(r.status))

const good = { ...sign('POST', '/v1/chat', sessionId, chatBody), 'X-Nexora-Open-Tx': tx }
r = await post('/v1/chat', chatBody, good)
const events = (await r.text()).trim().split('\n').map((l) => JSON.parse(l))
const text = events.filter((e) => e.type === 'token').map((e) => e.text).join('')
const usage = events.find((e) => e.type === 'usage')
const proof = events.find((e) => e.type === 'proof')?.proof
check('signed chat streams a reply', r.status === 200 && text.length > 0, `${text.slice(0, 70)}…`)
check('usage metered', !!usage && BigInt(usage.cost) > 0n, usage && `${usage.tokens} tokens`)
// Without NEARAI_API_KEY the reply is simulated, so the one reply-signature check is expected to fail.
const health = await (await fetch(`${GW}/v1/health`)).json()
const live = health.model_live
const tee = health.tee ?? health.provider === 'nearai'
if (tee) check(live ? 'TEE attestation + reply signature verified' : 'TEE attestation checks pass (reply simulated)', !!proof && (live ? proof.verified === true : proof.checks.filter((c) => c.name !== 'Reply signed by this model').every((c) => c.ok)), proof?.checks?.map((c) => `${c.ok ? '✓' : '✕'} ${c.name}`).join(', '))
else check('reply says where it ran (no TEE claimed)', proof?.kind === 'route' && proof.tee === false && !!proof.model, proof && `${proof.provider} · ${proof.model}${proof.host ? ` · run by ${proof.host}` : ''}`)

r = await post('/v1/chat', chatBody, good)
check('replayed request rejected', r.status === 401, String(r.status))

// Two requests at once must not both be served on one running total (the second would go uncharged).
const twin = (n) => JSON.stringify({ session_id: sessionId, account_id: owner, mode: 'B', prompt: `Reply with the single word ${n}.` })
const [b1, b2] = [twin('one'), twin('two')]
const pair = await Promise.all([post('/v1/chat', b1, sign('POST', '/v1/chat', sessionId, b1)), post('/v1/chat', b2, sign('POST', '/v1/chat', sessionId, b2))])
await Promise.all(pair.map((x) => x.text()))
check('overlapping requests: one served, one refused', pair.map((x) => x.status).sort().join() === '200,409', pair.map((x) => x.status).join())

const settleBody = JSON.stringify({ account_id: owner })
r = await post(`/v1/sessions/${sessionId}/settle`, settleBody, sign('POST', `/v1/sessions/${sessionId}/settle`, sessionId, settleBody))
const settled = await r.json()
check('settled on-chain with a receipt', r.status === 200 && settled.receipt?.outcome === 'Settled', settled.tx ?? settled.error)
if (settled.receipt) console.log(`      spent ${settled.receipt.spent} yocto, refunded ${settled.receipt.refunded}, receipt ${settled.receipt.receipt_hash}`)

// ---------- A session the user never ends must still be paid for ----------
console.log('\nAbandoned session: chat, then walk away…')
const ab = openSession({ cap: '5000000000000000000000', ttl_seconds: '60', client_key: `ed25519:${pub}` })
check('short session opened', !!ab.sessionId && !!ab.tx, `session ${ab.sessionId}`)
if (ab.sessionId) {
  const abBody = JSON.stringify({ session_id: ab.sessionId, account_id: owner, mode: 'B', prompt: 'Say hello in five words.' })
  r = await post('/v1/chat', abBody, { ...sign('POST', '/v1/chat', ab.sessionId, abBody), 'X-Nexora-Open-Tx': ab.tx })
  await r.text()
  check('chat on the short session', r.status === 200, String(r.status))
  console.log('      waiting for it to expire and for the gateway to settle it on its own (up to 3 minutes; light traffic meanwhile)…')
  const { JsonRpcProvider } = await import('near-api-js')
  const rpc = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || 'https://rpc.testnet.fastnear.com' })
  let receipt
  for (let i = 0; i < 36 && !receipt; i++) {
    await new Promise((res) => setTimeout(res, 5000))
    // On Vercel there is no always-on process: the cleanup rides on ordinary requests, so keep some coming.
    await fetch(`${GW}/v1/health`).catch(() => {})
    const receipts = await rpc.callFunction({ contractId, method: 'get_receipts', args: { account_id: owner }, blockQuery: { finality: 'optimistic' } }).catch(() => [])
    receipt = receipts.find((x) => x.session_id === ab.sessionId)
  }
  check('gateway settled the abandoned session with its metered cost', receipt?.outcome === 'Settled' && BigInt(receipt.spent) > 0n, receipt ? `spent ${receipt.spent} yocto` : 'no receipt')
}

// ---------- notes: buy a note in public, spend it with a zero-knowledge proof ----------
console.log('\nPrivate payment: buying a note…')
const pool = await (await fetch(`${GW}/v1/notes`)).json()
const identity = new Identity()
const buy = openSession({ cap: pool.price, ttl_seconds: '300', note_commitment: identity.commitment.toString() })
check('note purchase is on-chain', !!buy.sessionId && !!buy.tx, `session ${buy.sessionId}`)
if (!buy.sessionId || !buy.tx) process.exit(1)

r = await post('/v1/notes', JSON.stringify({ account_id: owner, session_id: buy.sessionId, tx: buy.tx }))
const sold = await r.json()
check('gateway took payment and listed the note', r.status === 200 && sold.anonymity_set >= 1, sold.error ?? `${sold.anonymity_set} note(s) in the pool, settle tx ${sold.settle_tx}`)

const list = await (await fetch(`${GW}/v1/notes`)).json()
const ask = ed25519.utils.randomSecretKey()
const apub = hex(ed25519.getPublicKey(ask))
const t0 = Date.now()
const zk = await generateProof(identity, new Group(list.commitments.map((c) => BigInt(c))), BigInt(keyMessage(apub)), BigInt(NOTE_SCOPE))
console.log(`      proof generated in ${Date.now() - t0} ms`)

// The proof and everything after it carry no account id.
const redeemBody = JSON.stringify({ proof: zk, client_key: `ed25519:${apub}` })
check('proof request names no account', !redeemBody.includes(owner))
r = await post('/v1/anon/sessions', redeemBody)
const anon = await r.json()
check('zero-knowledge proof accepted, anonymous session opened', r.status === 200 && /^[0-9a-f]{32}$/.test(anon.session_id ?? ''), anon.error ?? `${anon.tokens} tokens, hidden among ${anon.anonymity_set} note(s)`)

r = await post('/v1/anon/sessions', JSON.stringify({ proof: zk, client_key: `ed25519:${apub}` }))
check('same note cannot be spent twice', r.status === 400 && /not spent before/i.test((await r.json()).error ?? ''), String(r.status))

if (anon.session_id) {
  const asign = (path, body) => {
    const ts = String(Date.now())
    const msg = `nexora-auth-v1\nPOST ${path}\n${anon.session_id}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`
    return { 'X-Nexora-Ts': ts, 'X-Nexora-Sig': hex(ed25519.sign(new TextEncoder().encode(msg), ask)) }
  }
  const aBody = JSON.stringify({ anon_session: anon.session_id, mode: 'A', prompt: 'In one sentence: what is a zero-knowledge proof?' })
  r = await post('/v1/chat', aBody)
  check('unsigned anonymous chat rejected', r.status === 401, String(r.status))
  r = await post('/v1/chat', aBody, asign('/v1/chat', aBody))
  const aEvents = (await r.text()).trim().split('\n').map((l) => JSON.parse(l))
  const aText = aEvents.filter((e) => e.type === 'token').map((e) => e.text).join('')
  const aProof = aEvents.find((e) => e.type === 'proof' && e.proof.kind === 'zk')?.proof
  const aTee = aEvents.find((e) => e.type === 'proof' && e.proof.kind === 'tee')?.proof
  check('anonymous chat streams a reply', r.status === 200 && aText.length > 0, `${aText.slice(0, 70)}…`)
  const aRoute = aEvents.find((e) => e.type === 'proof' && e.proof.kind === 'route')?.proof
  if (tee) check('private chat also gets a verified TEE attestation', aTee?.verified === true || (!live && aTee?.checks?.filter((c) => c.name !== 'Reply signed by this model').every((c) => c.ok)), aTee ? `${aTee.checks.filter((c) => c.ok).length}/${aTee.checks.length} checks` : 'none')
  else check('private chat says where it ran', aRoute?.tee === false && !!aRoute.model, aRoute?.model)
  check('payment proof verified', aProof?.kind === 'zk' && aProof.verified === true, aProof?.checks?.map((c) => `${c.ok ? '✓' : '✕'} ${c.name}`).join(', '))
  const meter = await (await fetch(`${GW}/v1/metering?ids=${anon.session_id}`)).json()
  check('usage metered against the note', BigInt(meter[anon.session_id] ?? '0') > 0n, `${meter[anon.session_id]} yocto of ${anon.cap}`)
  const closePath = `/v1/anon/sessions/${anon.session_id}/close`
  r = await post(closePath, '{}', asign(closePath, '{}'))
  check('anonymous session closed', r.status === 200, String(r.status))
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
