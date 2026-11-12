// Mode A notes with REAL Semaphore proofs (the prover downloads its circuit files on first run).
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Group, Identity, generateProof } from '@semaphore-protocol/core'
import { authMessage } from '../src/auth.js'
import { NOTE_SCOPE, createNotes, keyMessage, parseCommitment } from '../src/notes.js'

const PRICE = '20000000000000000000000'
const hex = (b) => Buffer.from(b).toString('hex')

/** A notes store over a fake chain where every purchase transaction is valid. */
function setup(overrides = {}) {
  const settled = []
  const sessions = {}
  const txArgs = {}
  const chain = {
    rpcUrl: 'unused',
    contractId: 'credits.test',
    getSession: async (id) => sessions[id] ?? null,
    settleExact: async (id, spent, hash) => {
      settled.push({ id, spent, hash })
      delete sessions[id]
      return { tx: `settle-${id}` }
    },
  }
  const notes = createNotes({ file: join(mkdtempSync(join(tmpdir(), 'nexora-notes-')), 'notes.json'), priceYocto: PRICE, yoctoPerToken: 20_000_000_000_000_000_000n, chain, ...overrides })
  return { notes, settled, sessions, txArgs }
}

/** Put commitments straight into the list (the purchase path is tested separately). */
function seed(notes, identities) {
  const file = join(mkdtempSync(join(tmpdir(), 'nexora-notes-')), 'notes.json')
  void notes
  return createNotes({
    file,
    priceYocto: PRICE,
    yoctoPerToken: 20_000_000_000_000_000_000n,
    preload: identities.map((i, n) => ({ commitment: i.commitment.toString(), session_id: String(n + 1) })),
  })
}

function sessionKey() {
  const sk = ed25519.utils.randomSecretKey()
  return { sk, pub: hex(ed25519.getPublicKey(sk)) }
}

async function proofFor(identity, all, pub, scope = NOTE_SCOPE) {
  return generateProof(identity, new Group(all.map((i) => i.commitment)), BigInt(keyMessage(pub)), BigInt(scope))
}

const ids = [new Identity(), new Identity(), new Identity()]

// The prover keeps worker threads alive; stop them so the test process can exit.
after(async () => {
  await globalThis.curve_bn128?.terminate()
})

test('a paid note opens one anonymous session, and only once', async () => {
  const notes = seed(null, ids)
  assert.equal(notes.info().commitments.length, 3)
  const k = sessionKey()
  const proof = await proofFor(ids[1], ids, k.pub)
  const s = await notes.redeem({ proof, clientKey: `ed25519:${k.pub}` })
  assert.match(s.session_id, /^[0-9a-f]{32}$/)
  assert.equal(s.tokens, 1000)
  assert.equal(s.anonymity_set, 3)

  // The session answers only to the key the proof was bound to.
  const body = '{"prompt":"hi"}'
  const ts = String(Date.now())
  const sig = hex(ed25519.sign(new TextEncoder().encode(authMessage('POST', '/v1/chat', s.session_id, ts, body)), k.sk))
  const req = { url: '/v1/chat', method: 'POST', headers: { 'x-nexora-ts': ts, 'x-nexora-sig': sig }, rawBody: body }
  const rec = notes.auth(s.session_id, req)
  assert.equal(rec.mode, 'A')
  assert.equal(notes.proofFor(rec, true).verified, true)
  const other = sessionKey()
  const badSig = hex(ed25519.sign(new TextEncoder().encode(authMessage('POST', '/v1/chat', s.session_id, ts, body)), other.sk))
  assert.throws(() => notes.auth(s.session_id, { ...req, headers: { 'x-nexora-ts': ts, 'x-nexora-sig': badSig } }), /does not match/)

  // Double spend: the same note again, even with a new key and a new proof, has the same nullifier.
  const k2 = sessionKey()
  await assert.rejects(notes.redeem({ proof: await proofFor(ids[1], ids, k2.pub), clientKey: `ed25519:${k2.pub}` }), /Note not spent before/)
  // A different note still works.
  const k3 = sessionKey()
  assert.ok((await notes.redeem({ proof: await proofFor(ids[2], ids, k3.pub), clientKey: `ed25519:${k3.pub}` })).session_id)
})

test('proofs that do not fit are rejected', async () => {
  const notes = seed(null, ids)
  const k = sessionKey()
  const good = await proofFor(ids[0], ids, k.pub)
  // stolen proof used with someone else's key
  await assert.rejects(notes.redeem({ proof: good, clientKey: `ed25519:${sessionKey().pub}` }), /Bound to this session key/)
  // an identity that never paid (its own one-member list has a root we do not know)
  const outsider = new Identity()
  await assert.rejects(notes.redeem({ proof: await proofFor(outsider, [outsider], k.pub), clientKey: `ed25519:${k.pub}` }), /Note is in the paid list/)
  // wrong scope would give a second nullifier for the same note
  await assert.rejects(notes.redeem({ proof: await proofFor(ids[0], ids, k.pub, '12345'), clientKey: `ed25519:${k.pub}` }), /Proof is for this service/)
  // tampered proof
  const forged = { ...good, points: [...good.points.slice(0, 7), String(BigInt(good.points[7]) + 1n)] }
  await assert.rejects(notes.redeem({ proof: forged, clientKey: `ed25519:${k.pub}` }), /Zero-knowledge proof valid/)
  // nothing above burned the note
  assert.ok((await notes.redeem({ proof: good, clientKey: `ed25519:${k.pub}` })).session_id)
})

test('buying a note checks the price and the owner before taking payment', async () => {
  const { notes, settled, sessions } = setup({ readTx: async ({ sessionId }) => ({ note_commitment: sessionId === '7' ? ids[0].commitment.toString() : 'junk' }) })
  sessions['5'] = { owner: 'alice.test', cap: '10000000000000000000000' }
  sessions['6'] = { owner: 'bob.test', cap: PRICE }
  sessions['7'] = { owner: 'alice.test', cap: PRICE }
  sessions['8'] = { owner: 'alice.test', cap: PRICE }
  await assert.rejects(notes.register({ accountId: 'alice.test', sessionId: '5', txHash: 'x' }), /exactly the fixed price/)
  await assert.rejects(notes.register({ accountId: 'alice.test', sessionId: '6', txHash: 'x' }), /another account/)
  await assert.rejects(notes.register({ accountId: 'alice.test', sessionId: '8', txHash: 'x' }), /valid note commitment/)
  assert.equal(settled.length, 0)
  const r = await notes.register({ accountId: 'alice.test', sessionId: '7', txHash: 'x' })
  assert.equal(r.anonymity_set, 1)
  assert.deepEqual(settled.map((s) => [s.id, s.spent]), [['7', PRICE]])
  assert.match(settled[0].hash, /^[0-9a-f]{64}$/)
  // asking again for the same purchase does not charge or add twice
  assert.equal((await notes.register({ accountId: 'alice.test', sessionId: '7', txHash: 'x' })).index, 0)
  assert.equal(settled.length, 1)
  assert.equal(notes.info().commitments.length, 1)
})

test('parseCommitment accepts only field elements', () => {
  assert.equal(parseCommitment('123'), 123n)
  assert.equal(parseCommitment('0'), null)
  assert.equal(parseCommitment('0x12'), null)
  assert.equal(parseCommitment('21888242871839275222246405745257275088548364400416034343698204186575808495617'), null)
  assert.equal(parseCommitment(5), null)
})
