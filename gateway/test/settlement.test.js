import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readConfig, receiptHash, toYocto, validateSettlement } from '../src/settlement.js'

test('receiptHash is 64 lowercase hex and independent of key order', () => {
  const a = receiptHash({ session_id: '1', spent_yocto: '5', model: 'x' })
  const b = receiptHash({ model: 'x', spent_yocto: '5', session_id: '1' })
  assert.match(a, /^[0-9a-f]{64}$/) // the format the contract requires
  assert.equal(a, b)
  assert.notEqual(a, receiptHash({ session_id: '2', spent_yocto: '5', model: 'x' }))
})

test('toYocto converts without float error', () => {
  assert.equal(toYocto('1'), '1000000000000000000000000')
  assert.equal(toYocto('0.012'), '12000000000000000000000')
  assert.equal(toYocto('0.000000000000000000000001'), '1')
  assert.throws(() => toYocto('-1'))
  assert.throws(() => toYocto('1e3'))
})

const session = { cap: '1000', settle_deadline: '5000' }

test('validateSettlement mirrors the contract rules', () => {
  validateSettlement(session, '1000', '5000', 'gw.testnet') // spent == cap, at the deadline: ok
  assert.throws(() => validateSettlement(null, '1', '0', 'gw'), /not found/)
  assert.throws(() => validateSettlement(session, '1001', '0', 'gw'), /exceeds session cap/)
  assert.throws(() => validateSettlement(session, '1', '5001', 'gw'), /window has closed/)
  assert.throws(() => validateSettlement(session, '1', '0', undefined), /GATEWAY_ACCOUNT_ID/)
})

test('readConfig requires a contract id and defaults to testnet RPC', () => {
  assert.throws(() => readConfig({}), /CONTRACT_ID/)
  const cfg = readConfig({ CONTRACT_ID: 'c.testnet' })
  assert.equal(cfg.rpcUrl, 'https://rpc.testnet.fastnear.com')
})
