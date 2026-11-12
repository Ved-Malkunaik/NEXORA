#!/usr/bin/env node
// Testnet smoke test of the full session flow against a running gateway, without the browser.
//
//   node scripts/smoke.mjs <owner.testnet> [gateway_url]
//
// Needs near-cli-rs with <owner>'s key in the system keychain (it signs open_session). Opens a
// 0.005 NEAR session with a fresh chat key, then checks: unsigned and forged requests are rejected,
// a signed Mode B chat streams and returns an attestation, a replayed request is rejected, and the
// session settles on-chain with a receipt.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
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

console.log(`Opening a session on ${contractId} as ${owner}…`)
const cli = spawnSync(
  nearCli(),
  ['contract', 'call-function', 'as-transaction', contractId, 'open_session', 'json-args', JSON.stringify({ cap: '5000000000000000000000', ttl_seconds: '600', client_key: `ed25519:${pub}` }), 'prepaid-gas', '30 Tgas', 'attached-deposit', '0 NEAR', 'sign-as', owner, 'network-config', 'testnet', 'sign-with-keychain', 'send'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
)
// near-cli-rs prints the return value to stdout and the transaction details to stderr.
const out = `${cli.stdout ?? ''}\n${cli.stderr ?? ''}`
const sessionId = out.match(/^"(\d+)"\s*$/m)?.[1]
const tx = out.match(/Transaction ID: ([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1]
check('open_session returned an id and tx', !!sessionId && !!tx, `session ${sessionId}, tx ${tx}`)
if (!sessionId || !tx) process.exit(1)

const chatBody = JSON.stringify({ session_id: sessionId, account_id: owner, mode: 'B', prompt: 'In one sentence: what is a TEE?' })
const post = (path, body, headers = {}) => fetch(`${GW}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })

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
const live = (await (await fetch(`${GW}/v1/health`)).json()).model_live
check(live ? 'TEE attestation + reply signature verified' : 'TEE attestation checks pass (reply simulated)', !!proof && (live ? proof.verified === true : proof.checks.filter((c) => c.name !== 'Reply signed by this model').every((c) => c.ok)), proof?.checks.map((c) => `${c.ok ? '✓' : '✕'} ${c.name}`).join(', '))

r = await post('/v1/chat', chatBody, good)
check('replayed request rejected', r.status === 401, String(r.status))

const settleBody = JSON.stringify({ account_id: owner })
r = await post(`/v1/sessions/${sessionId}/settle`, settleBody, sign('POST', `/v1/sessions/${sessionId}/settle`, sessionId, settleBody))
const settled = await r.json()
check('settled on-chain with a receipt', r.status === 200 && settled.receipt?.outcome === 'Settled', settled.tx ?? settled.error)
if (settled.receipt) console.log(`      spent ${settled.receipt.spent} yocto, refunded ${settled.receipt.refunded}, receipt ${settled.receipt.receipt_hash}`)

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
