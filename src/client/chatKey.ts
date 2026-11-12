// Per-session "chat key": proves to the gateway that a request comes from the session's owner,
// without a wallet popup. Its public key is registered on-chain as an extra `client_key` argument of
// open_session (signed by the owner's session key); the private key stays in this browser.
// Mirrors gateway/src/auth.js.
import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

export interface ChatKey {
  secret: string
  publicKey: string
}

export function newChatKey(): ChatKey {
  const sk = ed25519.utils.randomPrivateKey()
  return { secret: bytesToHex(sk), publicKey: bytesToHex(ed25519.getPublicKey(sk)) }
}

/** The value passed as `client_key` to open_session. */
export const clientKeyArg = (k: ChatKey) => `ed25519:${k.publicKey}`

export function authMessage(method: string, path: string, sessionId: string, ts: string, body: string): string {
  return `nexora-auth-v1\n${method.toUpperCase()} ${path}\n${sessionId}\n${ts}\n${bytesToHex(sha256(new TextEncoder().encode(body)))}`
}

/** Headers for one signed gateway request. */
export function authHeaders(key: ChatKey, method: string, path: string, sessionId: string, body: string, openTx?: string): Record<string, string> {
  const ts = String(Date.now())
  const sig = ed25519.sign(new TextEncoder().encode(authMessage(method, path, sessionId, ts, body)), hexToBytes(key.secret))
  return { 'X-Nexora-Ts': ts, 'X-Nexora-Sig': bytesToHex(sig), ...(openTx ? { 'X-Nexora-Open-Tx': openTx } : {}) }
}
