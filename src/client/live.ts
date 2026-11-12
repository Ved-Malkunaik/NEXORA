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
import { viewFunction } from '../lib/rpc'
import { authHeaders, clientKeyArg, newChatKey, type ChatKey } from './chatKey'
import { INTENTS_ASSETS, oneClickQuote } from './intents'
import type {
  ChatEvent,
  ChatMessage,
  ContractConfig,
  CreditBalance,
  NexoraClient,
  PrivacyMode,
  Proof,
  Receipt,
  SessionInfo,
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

  private view<T>(method: string, args: object = {}) {
    return viewFunction<T>(this.cfg, method, args)
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
    const k = this.chatKey(sessionId)
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
    if (!b) return []
    const modes = this.local<Record<string, PrivacyMode>>('modes', {})
    const metering = await this.gateway<Record<string, string>>(`/v1/metering?ids=${b.open_sessions.join(',')}`).catch(
      () => ({}) as Record<string, string>,
    )
    const sessions = await Promise.all(b.open_sessions.map((id) => this.view<ChainSession | null>('get_session', { session_id: id })))
    return sessions
      .filter((s): s is ChainSession => !!s)
      .map((s) => ({ ...s, mode: modes[s.session_id] ?? 'B', metered: metering[s.session_id] ?? '0' }))
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

  async openSession(accountId: string, cap: Yocto, ttlSeconds: number, mode: PrivacyMode): Promise<SessionInfo> {
    // The chat key's public half goes on-chain in this call; the gateway checks requests against it.
    const key = newChatKey()
    const { value, tx } = await this.callTx('open_session', { cap, ttl_seconds: String(ttlSeconds), client_key: clientKeyArg(key) }, 0n)
    const id = value as string
    this.setLocal(`chatkey:${id}`, { ...key, tx })
    const modes = this.local<Record<string, PrivacyMode>>('modes', {})
    modes[id] = mode
    this.setLocal('modes', modes)
    const s = await this.view<ChainSession>('get_session', { session_id: id })
    void accountId
    return { ...s, mode, metered: '0' }
  }

  async closeSession(accountId: string, sessionId: string): Promise<Receipt> {
    const path = `/v1/sessions/${sessionId}/settle`
    const body = JSON.stringify({ account_id: accountId })
    const r = await this.gateway<{ receipt: Receipt; tx: string }>(path, { method: 'POST', body, headers: this.signed(sessionId, 'POST', path, body) })
    this.forget(sessionId)
    this.bump()
    return r.receipt
  }

  async reclaimSession(accountId: string, sessionId: string): Promise<Receipt> {
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

  async getProof(_accountId: string, sessionId: string): Promise<Proof | null> {
    return this.local<Proof | null>(`proof:${sessionId}`, null)
  }

  async *chat(accountId: string, sessionId: string, prompt: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const mode = this.local<Record<string, PrivacyMode>>('modes', {})[sessionId] ?? 'B'
    const history = this.local<ChatMessage[]>(`chat:${sessionId}`, [])
    const user: ChatMessage = { id: `${sessionId}-${history.length}`, role: 'user', content: prompt, at: Date.now() }
    const reply: ChatMessage = { id: `${sessionId}-${history.length + 1}`, role: 'assistant', content: '', at: Date.now() }
    const save = () => this.setLocal(`chat:${sessionId}`, [...history, user, reply])
    save()

    // Recent turns go along so the model has context; nothing is stored on the gateway.
    const body = JSON.stringify({
      session_id: sessionId,
      account_id: accountId,
      mode,
      prompt,
      history: history.filter((m) => !m.error && m.content).slice(-12).map((m) => ({ role: m.role, content: m.content })),
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
          else if (ev.type === 'proof') this.setLocal(`proof:${sessionId}`, ev.proof)
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
  /** True when the gateway has a NEAR AI Cloud API key, so replies come from the real model. */
  model_live?: boolean
  attested_model?: string
  attestation_verified?: boolean | null
}

export async function fetchGatewayHealth(): Promise<GatewayHealth> {
  const r = await fetch(`${GATEWAY_URL}/v1/health`).catch(() => {
    throw new Error('Not reachable. Start it with: cd gateway && npm start')
  })
  return r.json()
}
