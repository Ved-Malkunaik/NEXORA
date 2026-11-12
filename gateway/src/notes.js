// Mode A: pay for requests without the gateway learning which account paid.
//
// The idea is the one behind zkAPI (prepay, then prove in zero knowledge that a request is backed by
// a paid note), built on NEAR with Semaphore v4 proofs (Groth16).
//
//   BUY (public, like any deposit)
//     The browser makes a secret identity and sends its commitment on-chain as an extra
//     `note_commitment` argument of open_session, with cap = the fixed note price. The gateway reads
//     that transaction, settles the session at its full cap (the note is now paid for) and appends the
//     commitment to the public note list. All notes cost the same, so they look alike.
//
//   SPEND (anonymous)
//     Later, the browser proves "I know the secret behind ONE of the commitments in the list" without
//     saying which. The proof also carries a nullifier (a one-way tag of the secret, so the same note
//     cannot be spent twice) and is bound to a fresh request-signing key. The gateway checks the proof
//     and opens an anonymous session with the note's token budget. No account id is involved.
//
// What the gateway can and cannot tell is listed in docs/SECURITY_REPORT.md (it still sees the IP
// address and the prompt, and a pool with few notes hides little).
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Group, verifyProof } from '@semaphore-protocol/core'
import { parseClientKey, readOpenTx, verifyRequest } from './auth.js'
import { receiptHash } from './settlement.js'

/** BN254 scalar field: commitments, nullifiers and messages are field elements. */
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const toField = (label) => BigInt(`0x${createHash('sha256').update(label).digest('hex').slice(0, 62)}`)

/** Every proof must use this scope, so one note yields exactly one nullifier. */
export const NOTE_SCOPE = toField('nexora-zkapi-v1').toString()
/** The proof's message commits to the anonymous session's signing key. */
export const keyMessage = (publicKeyHex) => toField(`nexora-anon-key:${publicKeyHex.toLowerCase()}`).toString()

export const ANON_TTL_MS = 24 * 60 * 60_000
/** A proof may be built against a slightly older list; accept this many recent roots. */
const ROOT_HISTORY = 64

export function parseCommitment(v) {
  if (typeof v !== 'string' || !/^[1-9]\d{0,77}$/.test(v)) return null
  const n = BigInt(v)
  return n < FIELD ? n : null
}

/**
 * @param {object} o
 * @param {string} o.file          JSON state file (commitments, spent nullifiers, anonymous sessions)
 * @param {string} o.priceYocto    fixed note price
 * @param {bigint} o.yoctoPerToken
 * @param {object} [o.chain]       { rpcUrl, contractId, getSession, settleExact }: needed to sell notes
 * @param {Function} [o.verify]    proof verifier (injectable for tests)
 * @param {Function} [o.readTx]    reads a purchase transaction's arguments (injectable for tests)
 */
export function createNotes({ file, priceYocto, yoctoPerToken, chain, verify = verifyProof, readTx = readOpenTx, preload, now = () => Date.now() }) {
  let state = { leaves: [], nullifiers: {}, sessions: {} }
  try {
    state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    /* first run */
  }
  if (preload) state.leaves = preload // tests only
  const save = () => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state, null, 2))
  }

  const group = new Group()
  /** root (decimal) -> number of notes in the list when it was the root */
  const roots = new Map()
  const addLeaf = (commitment) => {
    group.addMember(BigInt(commitment))
    roots.set(group.root.toString(), group.size)
    if (roots.size > ROOT_HISTORY) roots.delete(roots.keys().next().value)
  }
  for (const l of state.leaves) addLeaf(l.commitment)

  const seenSignatures = new Map()
  const tokens = Number(BigInt(priceYocto) / yoctoPerToken)
  let queue = Promise.resolve()
  /** Note sales run one at a time so the list and the chain cannot disagree. */
  const serial = (fn) => (queue = queue.then(fn, fn))

  function info() {
    return { price: priceYocto, tokens, scope: NOTE_SCOPE, root: group.size ? group.root.toString() : null, commitments: state.leaves.map((l) => l.commitment) }
  }

  /** Sell a note: check the on-chain purchase, take payment, publish the commitment. */
  function register({ accountId, sessionId, txHash }) {
    return serial(async () => {
      const sold = state.leaves.find((l) => l.session_id === String(sessionId))
      if (sold) return { commitment: sold.commitment, index: state.leaves.indexOf(sold), anonymity_set: state.leaves.length }
      const s = await chain.getSession(sessionId)
      if (!s) throw new Error('That session is not open. A note is bought with a fresh session.')
      if (s.owner !== accountId) throw new Error('That session belongs to another account.')
      if (s.cap !== priceYocto) throw new Error('A note costs exactly the fixed price, so that all notes look alike.')
      const args = await readTx({ rpcUrl: chain.rpcUrl, contractId: chain.contractId, txHash, owner: s.owner, sessionId })
      const c = parseCommitment(args.note_commitment)
      if (c === null) throw new Error('That transaction does not carry a valid note commitment.')
      const commitment = c.toString()
      if (state.leaves.some((l) => l.commitment === commitment)) throw new Error('That note commitment is already in the list.')
      // Payment: the whole cap goes to the operator. The receipt hash commits to the note, not to usage.
      const hash = receiptHash({ type: 'zk-note', commitment, session_id: String(sessionId) })
      const { tx } = await chain.settleExact(sessionId, priceYocto, hash)
      state.leaves.push({ commitment, session_id: String(sessionId), open_tx: txHash, settle_tx: tx ?? null })
      addLeaf(commitment)
      save()
      return { commitment, index: state.leaves.length - 1, anonymity_set: state.leaves.length, settle_tx: tx ?? null }
    })
  }

  /** Spend a note: verify the zero-knowledge proof and open an anonymous session. */
  async function redeem({ proof, clientKey }) {
    const key = parseClientKey(clientKey)
    if (!key) throw new Error('Missing or malformed session key')
    const keyHex = Buffer.from(key).toString('hex')
    if (!proof || typeof proof !== 'object' || !Array.isArray(proof.points)) throw new Error('Missing proof')
    const checks = []
    const check = (name, ok, detail) => {
      checks.push({ name, ok: !!ok, detail })
      if (!ok) throw Object.assign(new Error(`${name}: failed`), { checks })
    }
    check('Proof is for this service', String(proof.scope) === NOTE_SCOPE, 'The proof was made for Nexora notes, so it yields this note’s one nullifier')
    const setSize = roots.get(String(proof.merkleTreeRoot))
    check('Note is in the paid list', setSize !== undefined, 'The proof’s Merkle root matches the public list of paid notes')
    check('Bound to this session key', String(proof.message) === keyMessage(keyHex), 'Only the holder of this session’s signing key can use the proof')
    let valid = false
    try {
      valid = await verify(proof)
    } catch {
      valid = false
    }
    check('Zero-knowledge proof valid', valid, 'Groth16 proof (Semaphore v4): the prover knows the secret of one paid note, without revealing which')
    const nullifier = String(proof.nullifier)
    check('Note not spent before', !(nullifier in state.nullifiers), 'This note’s nullifier has never been seen')

    state.nullifiers[nullifier] = now()
    const id = randomBytes(16).toString('hex')
    state.sessions[id] = { key: keyHex, metered: '0', tokens: 0, requests: 0, mode: 'A', expires_at: now() + ANON_TTL_MS, nullifier, root: String(proof.merkleTreeRoot), anonymity_set: setSize, checks }
    save()
    return { session_id: id, cap: priceYocto, tokens, expires_at: state.sessions[id].expires_at, anonymity_set: setSize }
  }

  /** Authenticate a request for an anonymous session. Returns its record. */
  function auth(id, req) {
    const rec = typeof id === 'string' ? state.sessions[id] : undefined
    if (!rec) throw new Error('This anonymous session is closed or unknown.')
    const path = new URL(req.url ?? '/', 'http://gateway').pathname
    verifyRequest({ publicKeyHex: rec.key, method: req.method, path, sessionId: id, ts: req.headers['x-nexora-ts'], sigHex: req.headers['x-nexora-sig'], body: req.rawBody ?? '', seen: seenSignatures })
    return rec
  }

  function close(id) {
    delete state.sessions[id]
    save()
  }

  /** What the chat panel shows for a request paid with a note. */
  function proofFor(rec, attestationVerified) {
    return {
      kind: 'zk',
      scheme: 'Semaphore v4 (Groth16) note, zkAPI-style',
      nullifier: rec.nullifier,
      proof_bytes: 256,
      key_reuse_window_s: Math.round(ANON_TTL_MS / 1000),
      verified: rec.checks.every((c) => c.ok),
      issued_at: now(),
      anonymity_set: rec.anonymity_set,
      checks: rec.checks,
      raw: { merkle_root: rec.root, scope: NOTE_SCOPE, anonymity_set: rec.anonymity_set, model_attestation_verified: attestationVerified },
    }
  }

  const metered = (id) => state.sessions[id]?.metered

  /** Drop anonymous sessions that have expired. Spent nullifiers are kept forever. */
  function prune() {
    const before = Object.keys(state.sessions).length
    for (const [id, rec] of Object.entries(state.sessions)) if (now() > rec.expires_at) delete state.sessions[id]
    if (Object.keys(state.sessions).length !== before) save()
  }

  return { info, register, redeem, auth, close, proofFor, metered, prune, save, priceYocto, tokens }
}
