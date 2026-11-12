import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { AUTH_WINDOW_MS, authMessage, parseClientKey, verifyRequest } from '../src/auth.js'

const hex = (b) => Buffer.from(b).toString('hex')

function signed(sk, { method = 'POST', path = '/v1/chat', sessionId = '7', ts = String(Date.now()), body = '{"prompt":"hi"}' } = {}) {
  const sigHex = hex(ed25519.sign(new TextEncoder().encode(authMessage(method, path, sessionId, ts, body)), sk))
  return { publicKeyHex: hex(ed25519.getPublicKey(sk)), method, path, sessionId, ts, sigHex, body }
}

test('a correctly signed request verifies', () => {
  verifyRequest(signed(ed25519.utils.randomSecretKey()))
})

test('a signature made by the browser client (src/client/chatKey.ts) verifies', () => {
  // Captured from the app: authHeaders(key, 'post', '/v1/chat', '42', '{"a":"é"}')
  verifyRequest({
    publicKeyHex: '951ba58ea755cf6764c60bcfe65f3a58083e56a3c32f4f014aaa6f9261a8cf1d',
    method: 'POST',
    path: '/v1/chat',
    sessionId: '42',
    ts: '1794506544256',
    sigHex: '1e13bfa842c871d810f0f7438e1e816750f9ad6005be06863b11d97036afaab91283aba250dc4d184dc8636a55551be948001af0bd45f40db92849652049f50e',
    body: '{"a":"é"}',
    now: 1794506544256,
  })
})

test('anything the signature covers cannot be changed', () => {
  const sk = ed25519.utils.randomSecretKey()
  const good = signed(sk)
  assert.throws(() => verifyRequest({ ...good, body: '{"prompt":"other"}' }), /does not match/)
  assert.throws(() => verifyRequest({ ...good, sessionId: '8' }), /does not match/)
  assert.throws(() => verifyRequest({ ...good, path: '/v1/sessions/7/settle' }), /does not match/)
  assert.throws(() => verifyRequest({ ...good, publicKeyHex: hex(ed25519.getPublicKey(ed25519.utils.randomSecretKey())) }), /does not match/)
  assert.throws(() => verifyRequest({ ...good, sigHex: undefined }), /Missing request signature/)
})

test('stale and replayed requests are rejected', () => {
  const sk = ed25519.utils.randomSecretKey()
  assert.throws(() => verifyRequest(signed(sk, { ts: String(Date.now() - AUTH_WINDOW_MS - 1000) })), /timestamp/)
  const seen = new Map()
  const req = signed(sk)
  verifyRequest({ ...req, seen })
  assert.throws(() => verifyRequest({ ...req, seen }), /already used/)
})

test('parseClientKey accepts only ed25519:<64 hex>', () => {
  assert.equal(parseClientKey(`ed25519:${'ab'.repeat(32)}`).length, 32)
  assert.equal(parseClientKey('ed25519:00'), null)
  assert.equal(parseClientKey(undefined), null)
})
