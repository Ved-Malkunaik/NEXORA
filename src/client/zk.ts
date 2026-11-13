// Private payment in the browser: make a note, and later prove in zero knowledge that you hold a paid one.
// Mirrors gateway/src/notes.js. The proof library (Semaphore v4, Groth16) is loaded on demand because
// it is large, and it downloads its circuit files the first time a proof is made.
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

const toField = (label: string) => BigInt(`0x${bytesToHex(sha256(new TextEncoder().encode(label))).slice(0, 62)}`)

/** Must equal NOTE_SCOPE on the gateway: one nullifier per note. */
export const NOTE_SCOPE = toField('nexora-zkapi-v1').toString()
/** Must equal keyMessage() on the gateway: binds a proof to the anonymous session's signing key. */
export const keyMessage = (publicKeyHex: string) => toField(`nexora-anon-key:${publicKeyHex.toLowerCase()}`)

/** A note as kept in this browser. `secret` is the only thing that can spend it. */
export interface Note {
  secret: string
  commitment: string
  /** paying: bought on-chain (or about to be), not yet confirmed in the gateway's list. */
  state: 'paying' | 'ready'
  bought_at: number
  session_id?: string
  tx?: string
}

export interface SemaphoreProof {
  merkleTreeDepth: number
  merkleTreeRoot: string
  nullifier: string
  message: string
  scope: string
  points: string[]
}

const lib = () => import('@semaphore-protocol/core')

export async function newNote(): Promise<Note> {
  const { Identity } = await lib()
  const id = new Identity()
  return { secret: id.export(), commitment: id.commitment.toString(), state: 'paying', bought_at: Date.now() }
}

/**
 * Prove that `note` is one of `commitments` without revealing which, bound to `publicKeyHex`.
 * Takes a few seconds; the first call also downloads the circuit files.
 */
export async function proveNote(note: Note, commitments: string[], publicKeyHex: string): Promise<SemaphoreProof> {
  const { Identity, Group, generateProof } = await lib()
  if (!commitments.includes(note.commitment)) throw new Error('Your note is not in the gateway’s list of paid notes yet.')
  const proof = await generateProof(Identity.import(note.secret), new Group(commitments.map((c) => BigInt(c))), keyMessage(publicKeyHex), BigInt(NOTE_SCOPE))
  return proof as SemaphoreProof
}
