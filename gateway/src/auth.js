// Caller authentication for the gateway, with no extra wallet popup.
//
// When the browser opens a session it generates an ed25519 "chat key" and passes its public key as an
// extra `client_key` argument to open_session (the contract ignores unknown args). That puts the key in
// a transaction signed by the session owner's own access key, on-chain. The gateway reads that
// transaction once, checks it really opened this session for this owner, and from then on accepts a
// request for the session only if it is signed by that chat key.
//
// Signed message (UTF-8):  nexora-auth-v1\n<METHOD> <path>\n<session_id>\n<ts_ms>\n<sha256(body) hex>
import { createHash } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'

export const AUTH_WINDOW_MS = 2 * 60_000

const sha256hex = (data) => createHash('sha256').update(data).digest('hex')

export function authMessage(method, path, sessionId, ts, body) {
  return `nexora-auth-v1\n${method.toUpperCase()} ${path}\n${sessionId}\n${ts}\n${sha256hex(body ?? '')}`
}

/** "ed25519:<64 hex>" -> Uint8Array(32), or null. */
export function parseClientKey(k) {
  const m = /^ed25519:([0-9a-f]{64})$/i.exec(String(k ?? ''))
  return m ? Uint8Array.from(Buffer.from(m[1], 'hex')) : null
}

/**
 * Read an open_session transaction and return its arguments, after checking it is a successful
 * open_session on `contractId`, signed by `owner`, that returned `sessionId`.
 */
export async function readOpenTx({ rpcUrl, contractId, txHash, owner, sessionId }) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(txHash ?? ''))) throw new Error('Missing or malformed open-session transaction hash')
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'nexora', method: 'tx', params: { tx_hash: txHash, sender_account_id: owner, wait_until: 'FINAL' } }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await res.json()
  if (body.error) throw new Error(`Could not read the open-session transaction: ${body.error.data ?? body.error.message ?? 'RPC error'}`)
  const { transaction: tx, status } = body.result ?? {}
  if (!tx || tx.signer_id !== owner || tx.receiver_id !== contractId) throw new Error('That transaction was not sent by the session owner to the credits contract')
  const call = tx.actions?.length === 1 ? tx.actions[0]?.FunctionCall : null
  if (call?.method_name !== 'open_session') throw new Error('That transaction is not an open_session call')
  const ret = status?.SuccessValue ? JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString('utf8')) : null
  if (String(ret) !== String(sessionId)) throw new Error('That transaction opened a different session')
  return JSON.parse(Buffer.from(call.args, 'base64').toString('utf8'))
}

/** The chat key a session registered in its open_session transaction (hex). */
export async function clientKeyFromOpenTx(params) {
  const args = await readOpenTx(params)
  const key = parseClientKey(args.client_key)
  if (!key) throw new Error('This session was opened without a chat key. Open a new session from the app.')
  return Buffer.from(key).toString('hex')
}

/** Verify a request signature. Throws with a user-facing message on failure. */
export function verifyRequest({ publicKeyHex, method, path, sessionId, ts, sigHex, body, now = Date.now(), seen }) {
  const t = Number(ts)
  if (!Number.isFinite(t) || Math.abs(now - t) > AUTH_WINDOW_MS) throw new Error('Request timestamp is missing or too far from the gateway clock')
  if (!/^[0-9a-f]{128}$/i.test(String(sigHex ?? ''))) throw new Error('Missing request signature')
  const msg = new TextEncoder().encode(authMessage(method, path, sessionId, ts, body))
  const ok = ed25519.verify(Buffer.from(sigHex, 'hex'), msg, Buffer.from(publicKeyHex, 'hex'))
  if (!ok) throw new Error('Request signature does not match this session’s chat key')
  // Replay protection: each signature is accepted once within the time window.
  if (seen) {
    if (seen.has(sigHex)) throw new Error('This request was already used')
    seen.set(sigHex, t)
    for (const [k, v] of seen) if (now - v > AUTH_WINDOW_MS) seen.delete(k)
  }
}
