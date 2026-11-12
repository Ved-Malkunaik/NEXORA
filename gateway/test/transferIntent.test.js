// Tests the browser's transfer-request parser (src/lib/transferIntent.ts). It lives here because
// the gateway package already has a test runner; Node strips the TypeScript types on import.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isValidAccountId, nearToYocto, parseTransfer } from '../../src/lib/transferIntent.ts'

const ok = (prompt) => {
  const r = parseTransfer(prompt)
  assert.equal(r.kind, 'transfer', prompt)
  return r.intent
}

test('reads the amount and recipient from plain-language requests', () => {
  assert.deepEqual(ok('hey , send 0.001 near tokens to vedd.near'), { to: 'vedd.near', yocto: '1000000000000000000000', amount: '0.001' })
  assert.deepEqual(ok('Transfer 1 NEAR to alice.testnet.'), { to: 'alice.testnet', yocto: '1000000000000000000000000', amount: '1' })
  assert.equal(ok('please pay 2,5 near to Bob.Near').yocto, '2500000000000000000000000')
  assert.equal(ok('send .5 NEAR to @carol.testnet now').to, 'carol.testnet')
  assert.deepEqual(ok('pay dave.near 0.25 near'), { to: 'dave.near', yocto: '250000000000000000000000', amount: '0.25' })
  const implicit = 'ab'.repeat(32)
  assert.equal(ok(`send 3 near to ${implicit}`).to, implicit)
})

test('exact to the yocto, no float rounding', () => {
  assert.equal(ok('send 0.000000000000000000000001 near to a.near').yocto, '1')
  assert.equal(ok('send 123456789.123456789 near to a.near').yocto, '123456789123456789000000000000000')
  assert.equal(nearToYocto('0.1'), '100000000000000000000000')
})

test('ordinary chat and questions are not treated as transfers', () => {
  for (const p of [
    'Summarize my medical report in plain words',
    'How do I send 1 NEAR to alice.near?',
    'what happens if I transfer 5 near to bob.near',
    'send my regards to the team',
    'send 5 USDC to alice.near',
    'I sent 1 near yesterday',
  ])
    assert.equal(parseTransfer(p).kind, 'none', p)
})

test('unsafe or malformed requests are rejected, not guessed', () => {
  assert.equal(parseTransfer('send 0 near to alice.near').kind, 'invalid')
  assert.equal(parseTransfer('send 1 near to a').kind, 'invalid')
  assert.equal(parseTransfer('send 1 near to alice..near').kind, 'invalid')
  assert.equal(parseTransfer(`send 0.${'1'.repeat(25)} near to alice.near`).kind, 'invalid')
  // A negative number must never become a positive transfer.
  assert.equal(parseTransfer('send -5 near to alice.near').kind, 'none')
})

test('account id validation follows NEAR rules', () => {
  assert.ok(isValidAccountId('vedd.near'))
  assert.ok(isValidAccountId('a-b_c.testnet'))
  assert.ok(!isValidAccountId('Alice.near'))
  assert.ok(!isValidAccountId('a'))
  assert.ok(!isValidAccountId('-a.near'))
  assert.ok(!isValidAccountId('a'.repeat(65)))
})
