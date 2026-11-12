import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

const sha = (s) => createHash('sha256').update(s).digest('hex')

function ethKey() {
  const sk = secp256k1.utils.randomSecretKey()
  const pub = secp256k1.getPublicKey(sk, false)
  const address = `0x${Buffer.from(keccak_256(pub.subarray(1))).subarray(12).toString('hex')}`
  const sign = (text) => {
    const msg = Buffer.from(text)
    const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]))
    const s = secp256k1.sign(digest, sk, { prehash: false, format: 'recovered' })
    return `0x${Buffer.concat([Buffer.from(s.subarray(1)), Buffer.from([s[0] + 27])]).toString('hex')}`
  }
  return { address, sign }
}

/** A minimal TDX v4 quote with chosen mrtd, mrconfig and report_data. */
function fakeQuote({ mrtd, mrconfig, reportData }) {
  const q = Buffer.alloc(48 + 584 + 4)
  q.writeUInt16LE(4, 0)
  q.writeUInt32LE(0x81, 4)
  Buffer.from(mrtd, 'hex').copy(q, 48 + 136)
  Buffer.from(mrconfig, 'hex').copy(q, 48 + 184)
  Buffer.from(reportData, 'hex').copy(q, 48 + 520)
  return q.toString('hex')
}

const { localChecks, parseTdxQuote, recoverAddress, verifySignature, streamChat } = await import('../src/nearai.js')

test('recoverAddress returns the Ethereum address that signed the text', () => {
  const k = ethKey()
  assert.equal(recoverAddress('model:aa:bb', k.sign('model:aa:bb')), k.address)
  assert.notEqual(recoverAddress('model:aa:bc', k.sign('model:aa:bb')), k.address)
})

test('localChecks pass for a consistent report and catch each tampering', () => {
  const nonce = 'ab'.repeat(32)
  const address = '0x' + '12'.repeat(20)
  const appCompose = '{"name":"x"}'
  const mrtd = 'cd'.repeat(48)
  const good = {
    request_nonce: nonce,
    signing_address: address,
    intel_quote: fakeQuote({ mrtd, mrconfig: `01${sha(appCompose)}`.padEnd(96, '0'), reportData: '12'.repeat(20).padEnd(64, '0') + nonce }),
    info: { tcb_info: JSON.stringify({ mrtd, app_compose: appCompose }) },
  }
  assert.ok(localChecks(good, nonce).every((c) => c.ok))
  assert.equal(parseTdxQuote(good.intel_quote).mrtd, mrtd)

  const failing = (m, n = nonce) => localChecks(m, n).filter((c) => !c.ok).map((c) => c.name)
  assert.deepEqual(failing(good, 'ef'.repeat(32)), ['Fresh nonce', 'Signing key bound to quote'])
  assert.deepEqual(failing({ ...good, signing_address: '0x' + '34'.repeat(20) }), ['Signing key bound to quote'])
  assert.deepEqual(failing({ ...good, info: { tcb_info: { mrtd: 'ee'.repeat(48), app_compose: appCompose } } }), ['MRTD matches'])
  assert.deepEqual(failing({ ...good, info: { tcb_info: { mrtd, app_compose: '{"name":"evil"}' } } }), ['App config matches'])
})

test('verifySignature binds the signer, the request and the response', () => {
  const model = ethKey()
  const gateway = ethKey()
  const requestBody = '{"prompt":"hi"}'
  const responseBody = 'data: {"x":1}\n\n'
  const text = `m:${sha(requestBody)}:${sha(responseBody)}`
  const ok = verifySignature({ text, signature: model.sign(text), signature_kind: 'provider_tee' }, { modelAddress: model.address, gatewayAddress: gateway.address, requestBody, responseBody })
  assert.ok(ok.every((c) => c.ok))
  const viaGateway = verifySignature({ text, signature: gateway.sign(text), signature_kind: 'gateway' }, { modelAddress: model.address, gatewayAddress: gateway.address, requestBody, responseBody })
  assert.ok(viaGateway.every((c) => c.ok))
  const wrongKey = verifySignature({ text, signature: ethKey().sign(text), signature_kind: 'provider_tee' }, { modelAddress: model.address, requestBody, responseBody })
  assert.equal(wrongKey.find((c) => c.name === 'Signed by the attested key').ok, false)
  const tampered = verifySignature({ text, signature: model.sign(text) }, { modelAddress: model.address, requestBody, responseBody: responseBody + ' ' })
  assert.equal(tampered.find((c) => c.name === 'Response hash matches').ok, false)
})

test('streamChat parses an OpenAI-style SSE stream and keeps the exact bytes', async () => {
  const chunks = [
    'data: {"id":"chat-1","choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"id":"chat-1","choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"id":"chat-1","choices":[],"usage":{"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
  ]
  let seen = ''
  const server = createServer(async (req, res) => {
    for await (const c of req) seen += c
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const c of chunks) res.write(c)
    res.end()
  })
  await new Promise((r) => server.listen(0, r))
  process.env.NEARAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  const mod = await import(`../src/nearai.js?base=${Date.now()}`)
  const events = []
  for await (const ev of mod.streamChat({ apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }] })) events.push(ev)
  server.close()
  delete process.env.NEARAI_BASE_URL
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello')
  const end = events.at(-1)
  assert.equal(end.id, 'chat-1')
  assert.equal(end.usage.total_tokens, 7)
  assert.equal(end.responseBody, chunks.join(''))
  assert.equal(end.requestBody, seen)
  void streamChat
})
