// Live client: real contract reads and wallet-signed transactions on credits.vedd.testnet,
// chat + settlement through the Nexora gateway (gateway/src/server.js).
//
//   deposit / withdraw / unregister  -> wallet popup (they carry a deposit)
//   open_session / reclaim_session   -> signed with the session key (no popup where the wallet supports it)
//   settle_session                   -> only the gateway can call it; it charges what IT metered
//
// Chat content never leaves the browser except to the gateway for the request itself; the
// transcript is kept in this browser's localStorage, not on any server.
import { actionCreators, type WalletSelector } from '@near-wallet-selector/core'
import type { NetworkConfig } from '../config/networks'
import { formatNear } from '../lib/near-amount'
import { viewAccount, viewFunction } from '../lib/rpc'
import { authHeaders, clientKeyArg, newChatKey, type ChatKey } from './chatKey'
import { INTENTS_ASSETS, oneClickQuote } from './intents'
import { newNote, proveNote, type Note } from './zk'
import type {
  ChatEvent,
  ChatMessage,
  ContractConfig,
  CreditBalance,
  NexoraClient,
  NoteInfo,
  PaymentProof,
  PrivacyMode,
  Proof,
  Receipt,
  RecipientStatus,
  RouteInfo,
  SessionInfo,
  TeeAttestation,
  Yocto,
} from './types'

const TGAS = 10n ** 12n
export const GATEWAY_URL: string = import.meta.env.VITE_GATEWAY_URL || 'http://localhost:8787'

interface ChainSession {
  session_id: string
  owner: string
  cap: string
  opened_at: string
  expires_at: string
  settle_deadline: string
}

/** GET /v1/notes */
interface GatewayNotes {
  price: string
  tokens: number
  scope: string
  root: string | null
  commitments: string[]
}

/** A private session paid with a note. Lives on the gateway and in this browser, not on-chain. */
interface AnonSession {
  /** Id shown in the app ("a-1a2b3c4d"). */
  ui_id: string
  /** The gateway's id: a bearer handle, kept out of the UI. */
  id: string
  key: ChatKey
  cap: string
  opened_at: number
  expires_at: number
  anonymity_set: number
}

const isAnon = (sessionId: string) => sessionId.startsWith('a-')
const msToNs = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString()

interface Outcome {
  status?: { SuccessValue?: string; Failure?: unknown } | string
  transaction?: { hash?: string }
  transaction_outcome?: { id?: string }
}

/** Pull a readable message out of a wallet / RPC / contract error. */
export function describeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)
  const panic = raw.match(/Smart contract panicked: ([^"\\]+)/)
  if (panic) return panic[1].trim()
  if (/reject|cancel|denied|closed/i.test(raw)) return 'Cancelled in the wallet'
  return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw
}

function outcomeValue(o: Outcome | void): unknown {
  const st = o?.status
  if (st && typeof st === 'object') {
    if ('Failure' in st && st.Failure) throw new Error(JSON.stringify(st.Failure))
    if (st.SuccessValue) {
      const json = atob(st.SuccessValue)
      return json ? JSON.parse(json) : null
    }
  }
  return null
}

/** The last few turns, newest kept first, within the gateway's 24k-character context budget. */
function recentTurns(history: ChatMessage[]): { role: ChatMessage['role']; content: string }[] {
  const out: { role: ChatMessage['role']; content: string }[] = []
  let budget = 20_000
  for (const m of history.filter((x) => !x.error && !x.action && x.content).slice(-12).reverse()) {
    const content = m.content.slice(0, 6000)
    budget -= content.length
    if (budget < 0) break
    out.unshift({ role: m.role, content })
  }
  return out
}

export class LiveClient implements NexoraClient {
  readonly kind = 'live' as const
  private version = 0
  private listeners = new Set<() => void>()
  private readonly cfg: NetworkConfig
  private readonly selector: WalletSelector

  constructor(cfg: NetworkConfig, selector: WalletSelector) {
    this.cfg = cfg
    this.selector = selector
  }

  // ---------- plumbing ----------

  subscribe(l: () => void) {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }
  getVersion() {
    return this.version
  }
  private bump() {
    this.version++
    this.listeners.forEach((l) => l())
  }

  private async view<T>(method: string, args: object = {}) {
    try {
      return await viewFunction<T>(this.cfg, method, args)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/does not exist|UNKNOWN_ACCOUNT|no contract code|CodeDoesNotExist/i.test(msg))
        throw new Error(`The credits contract (${this.cfg.contractId}) is not deployed on ${this.cfg.label.toLowerCase()} yet. Switch network in Settings.`)
      throw e
    }
  }

  /** The signed-in account. Notes and anonymous sessions are kept per account in this browser. */
  private me(): string {
    const accounts = this.selector.store.getState().accounts
    return (accounts.find((a) => a.active) ?? accounts[0])?.accountId ?? 'nobody'
  }

  private async call(method: string, args: object, deposit: bigint, gasTgas = 30n): Promise<unknown> {
    return (await this.callTx(method, args, deposit, gasTgas)).value
  }

  /** Like call(), but also returns the transaction hash. */
  private async callTx(method: string, args: object, deposit: bigint, gasTgas = 30n): Promise<{ value: unknown; tx: string | undefined }> {
    const wallet = await this.selector.wallet()
    try {
      const outcome = (await wallet.signAndSendTransaction({
        receiverId: this.cfg.contractId,
        actions: [actionCreators.functionCall(method, args, gasTgas * TGAS, deposit)],
      })) as Outcome | void
      const value = outcomeValue(outcome)
      this.bump()
      return { value, tx: outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id }
    } catch (e) {
      this.bump()
      throw new Error(describeError(e))
    }
  }

  private local<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`nexora:live:${this.cfg.contractId}:${key}`)
      return v ? (JSON.parse(v) as T) : fallback
    } catch {
      return fallback
    }
  }
  private setLocal(key: string, value: unknown) {
    try {
      localStorage.setItem(`nexora:live:${this.cfg.contractId}:${key}`, JSON.stringify(value))
    } catch {
      /* storage unavailable */
    }
  }

  /** The chat key for a session (see chatKey.ts), plus the open_session tx that registered it. */
  private chatKey(sessionId: string) {
    return this.local<(ChatKey & { tx?: string }) | null>(`chatkey:${sessionId}`, null)
  }

  /** Signed headers for a session request, or an error the user can act on. */
  private signed(sessionId: string, method: string, path: string, body: string): Record<string, string> {
    if (isAnon(sessionId)) {
      const a = this.anonSessions().find((x) => x.ui_id === sessionId)
      if (!a) throw new Error('This browser no longer holds the key for this anonymous session.')
      return authHeaders(a.key, method, path, a.id, body)
    }
    const k = this.chatKey(sessionId)
    if (k && !k.tx) throw new Error('Your wallet did not return the transaction that opened this session, so the gateway cannot check it is yours. Reclaim it after it expires, and try another wallet.')
    if (!k) throw new Error('This browser does not hold the chat key for this session (it was opened elsewhere or before this version). End it from the browser that opened it, or reclaim it after the deadline.')
    return authHeaders(k, method, path, sessionId, body, k.tx)
  }

  private async gateway<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${GATEWAY_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
    } catch {
      throw new Error(`Gateway not reachable at ${GATEWAY_URL}. Start it with: cd gateway && npm start`)
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error ?? `Gateway error ${res.status}`)
    return body as T
  }

  // ---------- reads (chain) ----------

  getConfig() {
    return this.view<ContractConfig>('get_config')
  }

  getBalance(accountId: string) {
    return this.view<CreditBalance | null>('get_balance', { account_id: accountId })
  }

  async getSessions(accountId: string): Promise<SessionInfo[]> {
    const b = await this.getBalance(accountId)
    const open = b?.open_sessions ?? []
    const anon = this.anonSessions()
    const modes = this.local<Record<string, PrivacyMode>>('modes', {})
    const ids = [...open, ...anon.map((a) => a.id)]
    const metering = ids.length
      ? await this.gateway<Record<string, string>>(`/v1/metering?ids=${ids.join(',')}`).catch(() => ({}) as Record<string, string>)
      : {}
    const sessions = await Promise.all(open.map((id) => this.view<ChainSession | null>('get_session', { session_id: id })))
    // A session that is buying a note is closed by the gateway within seconds; do not offer it as a chat.
    // If that never happened and it has expired, show it so the cap can be reclaimed.
    const buying = new Set(this.notes().filter((n) => n.state === 'paying').map((n) => n.session_id))
    const nowNs = BigInt(Date.now()) * 1_000_000n
    return [
      ...sessions
        .filter((s): s is ChainSession => !!s && !(buying.has(s.session_id) && nowNs <= BigInt(s.expires_at)))
        .map((s) => ({ ...s, mode: modes[s.session_id] ?? 'B', metered: metering[s.session_id] ?? '0' })),
      ...anon.map(
        (a): SessionInfo => ({
          session_id: a.ui_id,
          owner: accountId,
          cap: a.cap,
          opened_at: msToNs(a.opened_at),
          expires_at: msToNs(a.expires_at),
          settle_deadline: msToNs(a.expires_at),
          mode: 'A',
          metered: metering[a.id] ?? '0',
        }),
      ),
    ]
  }

  async getReceipts(accountId: string): Promise<Receipt[]> {
    return this.view<Receipt[]>('get_receipts', { account_id: accountId })
  }

  // ---------- writes (wallet) ----------

  async deposit(accountId: string, amount: Yocto) {
    await this.call('deposit', {}, BigInt(amount))
    return (await this.getBalance(accountId))!
  }

  async withdraw(accountId: string, amount: Yocto) {
    // withdraw + transfer + callback
    await this.call('withdraw', { amount }, 1n, 60n)
    return (await this.getBalance(accountId))!
  }

  async unregister() {
    await this.call('unregister', {}, 1n, 60n)
  }

  // ---------- private payment: notes and anonymous sessions ----------

  private notes() {
    return this.local<Note[]>(`notes:${this.me()}`, [])
  }
  private saveNote(note: Note) {
    this.setLocal(`notes:${this.me()}`, [...this.notes().filter((n) => n.commitment !== note.commitment), note])
  }
  private dropNote(commitment: string) {
    this.setLocal(`notes:${this.me()}`, this.notes().filter((n) => n.commitment !== commitment))
  }
  private anonSessions() {
    return this.local<AnonSession[]>(`anon:${this.me()}`, [])
  }

  async getNoteInfo(): Promise<NoteInfo | null> {
    const g = await this.gateway<GatewayNotes>('/v1/notes')
    const mine = this.notes().filter((n) => g.commitments.includes(n.commitment))
    return {
      price: g.price,
      tokens: g.tokens,
      pool: g.commitments.length,
      unspent: mine.length,
      oldest_unspent_at: mine.length ? Math.min(...mine.map((n) => n.bought_at)) : null,
    }
  }

  /**
   * Buy a note. This step is public: the purchase is an on-chain session for exactly the note price,
   * carrying the note's commitment, which the gateway settles in full and adds to its public list.
   */
  private async buyNote(accountId: string, price: string): Promise<Note> {
    // Finish a purchase that was interrupted after the on-chain step, rather than paying twice.
    let note = this.notes().find((n) => n.state === 'paying' && n.session_id && n.tx)
    if (!note) {
      note = await newNote()
      this.saveNote(note) // the secret is saved before any money moves
      try {
        const { value, tx } = await this.callTx('open_session', { cap: price, ttl_seconds: '300', note_commitment: note.commitment }, 0n)
        if (!tx) throw new Error('Your wallet did not return the transaction hash, so the note cannot be registered. The session can be reclaimed after it expires.')
        note = { ...note, session_id: value as string, tx }
        this.saveNote(note)
      } catch (e) {
        if (!note.session_id) this.dropNote(note.commitment)
        throw e
      }
    }
    try {
      await this.gateway('/v1/notes', { method: 'POST', body: JSON.stringify({ account_id: accountId, session_id: note.session_id, tx: note.tx }) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // The gateway refused this purchase for good (for example the session expired first). Nothing was
      // charged: forget the note so the next attempt starts clean. The session's cap can be reclaimed.
      if (!/not reachable|Gateway error 5|Settlement failed|Could not read/i.test(msg)) {
        this.dropNote(note.commitment)
        this.bump()
        throw new Error(`${msg} The note was not sold and nothing was charged; reclaim session #${note.session_id} after it expires.`)
      }
      throw e
    }
    note = { ...note, state: 'ready' }
    this.saveNote(note)
    this.bump()
    return note
  }

  /** Spend a note: prove in zero knowledge that it is paid, and get an anonymous session. No account id is sent. */
  private async openAnonSession(accountId: string): Promise<SessionInfo> {
    let info = await this.gateway<GatewayNotes>('/v1/notes')
    // Prefer the oldest note already in the list: the longer since purchase, the harder to link by timing.
    let note = this.notes()
      .filter((n) => info.commitments.includes(n.commitment))
      .sort((a, b) => a.bought_at - b.bought_at)[0]
    if (!note) {
      note = await this.buyNote(accountId, info.price)
      info = await this.gateway<GatewayNotes>('/v1/notes')
    }
    const key = newChatKey()
    const proof = await proveNote(note, info.commitments, key.publicKey)
    const r = await this.gateway<{ session_id: string; cap: string; expires_at: number; anonymity_set: number }>('/v1/anon/sessions', {
      method: 'POST',
      body: JSON.stringify({ proof, client_key: clientKeyArg(key) }),
    })
    this.dropNote(note.commitment) // spent
    const a: AnonSession = { ui_id: `a-${r.session_id.slice(0, 8)}`, id: r.session_id, key, cap: r.cap, opened_at: Date.now(), expires_at: r.expires_at, anonymity_set: r.anonymity_set }
    this.setLocal(`anon:${this.me()}`, [...this.anonSessions(), a])
    this.bump()
    return {
      session_id: a.ui_id,
      owner: accountId,
      cap: a.cap,
      opened_at: msToNs(a.opened_at),
      expires_at: msToNs(a.expires_at),
      settle_deadline: msToNs(a.expires_at),
      mode: 'A',
      metered: '0',
    }
  }

  /** Forget an anonymous session. Whatever is left of the note is not refunded. */
  private async closeAnonSession(sessionId: string, tellGateway: boolean): Promise<Receipt> {
    const a = this.anonSessions().find((x) => x.ui_id === sessionId)
    if (!a) throw new Error('This anonymous session is already closed.')
    if (tellGateway) {
      const path = `/v1/anon/sessions/${a.id}/close`
      await this.gateway(path, { method: 'POST', body: '{}', headers: authHeaders(a.key, 'POST', path, a.id, '{}') }).catch(() => undefined)
    }
    this.setLocal(`anon:${this.me()}`, this.anonSessions().filter((x) => x.ui_id !== sessionId))
    this.bump()
    return { session_id: sessionId, cap: a.cap, spent: a.cap, refunded: '0', receipt_hash: null, closed_at: msToNs(Date.now()), outcome: 'Settled' }
  }

  async openSession(accountId: string, cap: Yocto, ttlSeconds: number, mode: PrivacyMode): Promise<SessionInfo> {
    if (mode === 'A') return this.openAnonSession(accountId)
    // The chat key's public half goes on-chain in this call; the gateway checks requests against it.
    const key = newChatKey()
    const before = new Set((await this.getBalance(accountId))?.open_sessions ?? [])
    const { value, tx } = await this.callTx('open_session', { cap, ttl_seconds: String(ttlSeconds), client_key: clientKeyArg(key) }, 0n)
    // Some wallets do not hand back the call's result: find the session that just appeared.
    const id = typeof value === 'string' ? value : ((await this.getBalance(accountId))?.open_sessions ?? []).find((x) => !before.has(x))
    if (!id) throw new Error('The session was not opened. Check your wallet and try again.')
    this.setLocal(`chatkey:${id}`, { ...key, tx })
    const modes = this.local<Record<string, PrivacyMode>>('modes', {})
    modes[id] = mode
    this.setLocal('modes', modes)
    const s = await this.view<ChainSession>('get_session', { session_id: id })
    void accountId
    return { ...s, mode, metered: '0' }
  }

  async closeSession(accountId: string, sessionId: string): Promise<Receipt> {
    if (isAnon(sessionId)) return this.closeAnonSession(sessionId, true)
    const path = `/v1/sessions/${sessionId}/settle`
    const body = JSON.stringify({ account_id: accountId })
    const r = await this.gateway<{ receipt: Receipt; tx: string }>(path, { method: 'POST', body, headers: this.signed(sessionId, 'POST', path, body) })
    this.forget(sessionId)
    this.bump()
    return r.receipt
  }

  async reclaimSession(accountId: string, sessionId: string): Promise<Receipt> {
    if (isAnon(sessionId)) return this.closeAnonSession(sessionId, false) // expired on the gateway; nothing on-chain to reclaim
    await this.call('reclaim_session', { session_id: sessionId }, 0n)
    this.forget(sessionId)
    const receipts = await this.getReceipts(accountId)
    return receipts.find((r) => r.session_id === sessionId) ?? receipts[receipts.length - 1]
  }

  /** A closed session's chat key is useless; drop it. The transcript stays until the user clears it. */
  private forget(sessionId: string) {
    try {
      localStorage.removeItem(`nexora:live:${this.cfg.contractId}:chatkey:${sessionId}`)
    } catch {
      /* storage unavailable */
    }
  }

  // ---------- chat (gateway) ----------

  async getMessages(_accountId: string, sessionId: string): Promise<ChatMessage[]> {
    return this.local<ChatMessage[]>(`chat:${sessionId}`, [])
  }

  async getProof(_accountId: string, sessionId: string): Promise<TeeAttestation | RouteInfo | null> {
    const p = this.local<Proof | null>(`proof:${sessionId}`, null)
    return p && p.kind !== 'zk' ? p : null
  }

  async getPaymentProof(_accountId: string, sessionId: string): Promise<PaymentProof | null> {
    return this.local<PaymentProof | null>(`payproof:${sessionId}`, null)
  }

  async *chat(accountId: string, sessionId: string, prompt: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const mode: PrivacyMode = isAnon(sessionId) ? 'A' : (this.local<Record<string, PrivacyMode>>('modes', {})[sessionId] ?? 'B')
    const history = this.local<ChatMessage[]>(`chat:${sessionId}`, [])
    const user: ChatMessage = { id: `${sessionId}-${history.length}`, role: 'user', content: prompt, at: Date.now() }
    const reply: ChatMessage = { id: `${sessionId}-${history.length + 1}`, role: 'assistant', content: '', at: Date.now() }
    const save = () => this.setLocal(`chat:${sessionId}`, [...history, user, reply])
    save()

    // Recent turns go along so the model has context; nothing is stored on the gateway.
    const anon = isAnon(sessionId) ? this.anonSessions().find((x) => x.ui_id === sessionId) : undefined
    const body = JSON.stringify({
      // An anonymous session names no account: the gateway only sees the session handle.
      ...(anon ? { anon_session: anon.id } : { session_id: sessionId, account_id: accountId }),
      mode,
      prompt,
      history: recentTurns(history),
    })
    let headers: Record<string, string>
    try {
      headers = this.signed(sessionId, 'POST', '/v1/chat', body)
    } catch (e) {
      reply.error = e instanceof Error ? e.message : String(e)
      save()
      yield { type: 'error', code: 'SESSION_CLOSED', message: reply.error }
      return
    }
    let res: Response
    try {
      res = await fetch(`${GATEWAY_URL}/v1/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, signal })
    } catch {
      reply.error = 'Gateway not reachable'
      save()
      yield { type: 'error', code: 'GATEWAY_DOWN', message: `The gateway is not reachable at ${GATEWAY_URL}. Start it with: cd gateway && npm start` }
      return
    }
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}))
      reply.error = body.error ?? `Gateway error ${res.status}`
      save()
      yield { type: 'error', code: body.code ?? 'GATEWAY_DOWN', message: reply.error! }
      return
    }

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          const ev = JSON.parse(line) as ChatEvent
          if (ev.type === 'token') reply.content += ev.text
          else if (ev.type === 'usage') {
            reply.cost = ev.cost
            reply.tokens = ev.tokens
          } else if (ev.type === 'error') reply.error = ev.message
          else if (ev.type === 'proof') this.setLocal(ev.proof.kind === 'zk' ? `payproof:${sessionId}` : `proof:${sessionId}`, ev.proof)
          yield ev
        }
      }
    } catch (e) {
      if (!signal?.aborted) {
        reply.error = 'Connection to the gateway dropped'
        yield { type: 'error', code: 'GATEWAY_DOWN', message: 'Connection to the gateway dropped. Your credits are safe; try again.' }
      }
      void e
    } finally {
      save()
      this.bump()
    }
  }

  // ---------- wallet actions (any session) ----------

  async checkRecipient(to: string): Promise<RecipientStatus> {
    if (/^[0-9a-f]{64}$/.test(to)) return 'implicit'
    try {
      await viewAccount(this.cfg, to)
      return 'exists'
    } catch (e) {
      return /does not exist|UNKNOWN_ACCOUNT/i.test(e instanceof Error ? e.message : String(e)) ? 'missing' : 'unknown'
    }
  }

  async transferNear(_accountId: string, sessionId: string, to: string, amount: Yocto, prompt: string): Promise<ChatMessage[]> {
    const wallet = await this.selector.wallet()
    let tx: string | undefined
    try {
      const outcome = (await wallet.signAndSendTransaction({ receiverId: to, actions: [actionCreators.transfer(BigInt(amount))] })) as Outcome | void
      outcomeValue(outcome) // throws if the transaction failed on-chain
      tx = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id
    } catch (e) {
      throw new Error(describeError(e))
    }
    const history = this.local<ChatMessage[]>(`chat:${sessionId}`, [])
    const at = Date.now()
    const added: ChatMessage[] = [
      { id: `${sessionId}-${history.length}`, role: 'user', content: prompt, at, action: true },
      { id: `${sessionId}-${history.length + 1}`, role: 'assistant', content: `Sent ${formatNear(amount, 24)} NEAR to ${to} from your wallet.`, at, action: true, tx },
    ]
    this.setLocal(`chat:${sessionId}`, [...history, ...added])
    this.bump()
    return added
  }

  // ---------- funding ----------

  getAssets() {
    return INTENTS_ASSETS
  }
  /** Real dry-run price from the 1Click API (mainnet liquidity, also previewed on testnet). */
  getQuote(assetId: string, amountIn: string) {
    const accountId = this.selector.store.getState().accounts[0]?.accountId ?? ''
    return oneClickQuote(assetId, amountIn, accountId)
  }
  async fundWithQuote(): Promise<CreditBalance> {
    if (!this.cfg.intentsSupported) throw new Error('NEAR Intents funding is mainnet only. On testnet, deposit NEAR directly.')
    throw new Error('Executing the swap is not wired in this build. Swap to wNEAR at near-intents.org, unwrap it, then use Deposit.')
  }
}

export interface GatewayHealth {
  contract: string
  gateway: string | null
  can_settle: boolean
  model: string
  /** True when replies come from a real model (an API key is configured), not simulated. */
  model_live?: boolean
  /** Who runs the model: 'openrouter', 'nearai' (TEE) or 'simulated'. */
  provider?: 'openrouter' | 'nearai' | 'simulated'
  /** Prompts run in an attested TEE. */
  tee?: boolean
  /** OpenRouter models, tried in order. */
  models?: string[]
  /** OpenRouter free-tier usage the gateway is tracking. */
  limits?: { last_minute: number; today: number; per_minute: number; per_day: number }
  attested_model?: string
  attestation_verified?: boolean | null
}

export async function fetchGatewayHealth(): Promise<GatewayHealth> {
  const r = await fetch(`${GATEWAY_URL}/v1/health`).catch(() => {
    throw new Error('Not reachable. Start it with: cd gateway && npm start')
  })
  return r.json()
}
