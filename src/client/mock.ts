// In-browser stand-in for contract + gateway + NEAR AI Cloud + Intents.
// Enforces the same rules and error messages as contract/src/lib.rs so the UI's
// validation and error states are real. Everything it returns is labelled mock.
import { formatNear } from '../lib/near-amount'
import type {
  ChatEvent,
  ChatMessage,
  ContractConfig,
  CreditBalance,
  IntentsAsset,
  IntentsQuote,
  NexoraClient,
  PaymentProof,
  PrivacyMode,
  Proof,
  Receipt,
  RecipientStatus,
  SessionInfo,
  TeeAttestation,
  Yocto,
} from './types'

const NS = 1_000_000n
const NEAR = 10n ** 24n
const STORAGE_RESERVE = NEAR / 20n // 0.05
const MIN_AMOUNT = NEAR / 1000n // 0.001
const MAX_OPEN_SESSIONS = 4
const MAX_RECEIPTS = 20
const MIN_TTL = 60
const MAX_TTL = 86_400
const GRACE_S = 900
/** Mock price: 0.00002 NEAR per token, so a 0.05 NEAR cap buys ~2,500 tokens. */
const YOCTO_PER_TOKEN = 20_000_000_000_000_000_000n

interface AccountState {
  available: string
  locked: string
  reserve: string
  receipts: Receipt[]
}

interface State {
  accounts: Record<string, AccountState>
  sessions: Record<string, SessionInfo>
  messages: Record<string, ChatMessage[]>
  proofs: Record<string, Proof>
  /** Payment proofs of privately paid sessions (absent in data saved by older builds). */
  payProofs?: Record<string, PaymentProof>
  nextId: number
  fees: string
  timeOffsetMs: number
}

const FAIL_KEY = 'nexora:mock:simulate-failures'

const empty = (): State => ({ accounts: {}, sessions: {}, messages: {}, proofs: {}, nextId: 1, fees: '0', timeOffsetMs: 0 })

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })

/** Deterministic pseudo-hex for mock hashes and keys (not cryptographic). */
function mockHex(seed: string, bytes = 32): string {
  let h1 = 0x811c9dc5
  let out = ''
  for (let i = 0; out.length < bytes * 2; i++) {
    for (const ch of `${seed}:${i}`) h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0
    out += h1.toString(16).padStart(8, '0')
  }
  return out.slice(0, bytes * 2)
}

const ASSETS: IntentsAsset[] = [
  { id: 'near', symbol: 'NEAR', chain: 'NEAR', decimals: 24 },
  { id: 'usdc-eth', symbol: 'USDC', chain: 'Ethereum', decimals: 6 },
  { id: 'usdc-base', symbol: 'USDC', chain: 'Base', decimals: 6 },
  { id: 'usdt-tron', symbol: 'USDT', chain: 'Tron', decimals: 6 },
]
/** Mock rates in NEAR per unit (×1e6 for integer math). */
const RATE_E6: Record<string, bigint> = { near: 1_000_000n, 'usdc-eth': 312_500n, 'usdc-base': 312_500n, 'usdt-tron': 311_800n }

const ANSWERS: [RegExp, string][] = [
  [
    /medical|report|health|diagnos/i,
    'Here is a plain-language summary. The report lists three findings: blood counts within normal range, slightly raised LDL cholesterol, and vitamin D below the reference level. None of these is urgent. Common next steps are a repeat lipid panel in three months and asking your doctor whether a vitamin D supplement makes sense. Bring the original report to that appointment, since only your doctor can interpret it against your history.',
  ],
  [
    /term sheet|seed|investor|valuation/i,
    'A seed term sheet usually covers: amount raised and instrument (priced equity or SAFE), pre-money valuation or cap, option pool size and whether it sits pre- or post-money, liquidation preference (1x non-participating is standard), pro-rata rights, and board composition. Keep it short and non-binding except for confidentiality and exclusivity. Tell me your round size and target valuation and I will draft the clauses.',
  ],
  [
    /contract|clause|liabilit|indemn/i,
    'Watch for four things in a liability clause: an uncapped indemnity, a cap that excludes the obligations most likely to go wrong, consequential-loss carve-outs that swallow the cap, and one-sided survival periods. A balanced version caps liability at fees paid in the last twelve months, makes the cap mutual, and keeps carve-outs to fraud, wilful misconduct and confidentiality breaches. Paste the clause and I will mark it up.',
  ],
  [
    /tax|staking|reward/i,
    'In many jurisdictions staking rewards are taxed as income when you gain control of them, valued at the market price on that day, and again as a capital gain or loss when you later sell. Keep a record of each reward with its date and value. Rules differ a lot by country, so treat this as orientation, not tax advice, and check with a local professional before filing.',
  ],
]

function answerFor(prompt: string, mode: PrivacyMode): string {
  const hit = ANSWERS.find(([re]) => re.test(prompt))
  if (hit) return hit[1]
  return mode === 'B'
    ? 'Your prompt was processed inside a trusted execution environment. The model host cannot read it, and the attestation panel shows the proof for this answer. Ask me anything: drafting, summarising, reviewing code or documents.'
    : 'This request was paid with an anonymous credit, so the provider can check the payment is valid without learning which account sent it. Ask me anything: drafting, summarising, reviewing code or documents.'
}

export class MockClient implements NexoraClient {
  readonly kind = 'mock' as const
  private state: State
  private version = 0
  private listeners = new Set<() => void>()
  private readonly storageKey: string

  constructor(networkId: string) {
    this.storageKey = `nexora:mock:v1:${networkId}`
    this.state = this.load()
  }

  // ---------- plumbing ----------

  private load(): State {
    try {
      const raw = localStorage.getItem(this.storageKey)
      if (raw) return { ...empty(), ...JSON.parse(raw) }
    } catch {
      /* storage unavailable or corrupt: start fresh */
    }
    return empty()
  }

  private commit() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.state))
    } catch {
      /* in-memory only */
    }
    this.version++
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getVersion() {
    return this.version
  }

  private nowNs(): bigint {
    return BigInt(Date.now() + this.state.timeOffsetMs) * NS
  }

  private async latency(min = 350, max = 800) {
    await sleep(min + Math.random() * (max - min))
    if (this.failing()) throw new Error('RPC unavailable (simulated failure). Try again.')
  }

  private acct(accountId: string): AccountState {
    const a = this.state.accounts[accountId]
    if (!a) throw new Error('Account not registered')
    return a
  }

  private ownedSession(accountId: string, sessionId: string): SessionInfo {
    const s = this.state.sessions[sessionId]
    if (!s) throw new Error('Session not found or already closed')
    if (s.owner !== accountId) throw new Error('Only the session owner can do this')
    return s
  }

  private balanceView(accountId: string): CreditBalance | null {
    const a = this.state.accounts[accountId]
    if (!a) return null
    const open = Object.values(this.state.sessions)
      .filter((s) => s.owner === accountId)
      .map((s) => s.session_id)
    return { available: a.available, locked: a.locked, storage_reserve: a.reserve, open_sessions: open }
  }

  private close(s: SessionInfo, spent: bigint, outcome: Receipt['outcome']): Receipt {
    const a = this.acct(s.owner)
    const cap = BigInt(s.cap)
    const receipt: Receipt = {
      session_id: s.session_id,
      cap: s.cap,
      spent: spent.toString(),
      refunded: (cap - spent).toString(),
      receipt_hash: outcome === 'Settled' ? mockHex(`receipt:${s.session_id}:${spent}`) : null,
      closed_at: this.nowNs().toString(),
      outcome,
    }
    a.locked = (BigInt(a.locked) - cap).toString()
    a.available = (BigInt(a.available) + cap - spent).toString()
    a.receipts = [...a.receipts, receipt].slice(-MAX_RECEIPTS)
    this.state.fees = (BigInt(this.state.fees) + spent).toString()
    delete this.state.sessions[s.session_id]
    this.commit()
    return receipt
  }

  // ---------- developer controls (mock only) ----------

  failing(): boolean {
    try {
      return localStorage.getItem(FAIL_KEY) === '1'
    } catch {
      return false
    }
  }

  setFailing(on: boolean) {
    try {
      if (on) localStorage.setItem(FAIL_KEY, '1')
      else localStorage.removeItem(FAIL_KEY)
    } catch {
      /* ignore */
    }
    this.commit()
  }

  getTimeOffsetMs() {
    return this.state.timeOffsetMs
  }

  /** Move the mock clock forward, e.g. past a settle deadline to test reclaim. */
  advanceTime(seconds: number) {
    this.state.timeOffsetMs += seconds * 1000
    this.commit()
  }

  reset() {
    this.state = empty()
    this.commit()
  }

  /** Current mock time in ms (respects advanceTime). */
  now(): number {
    return Date.now() + this.state.timeOffsetMs
  }

  // ---------- reads ----------

  async getConfig(): Promise<ContractConfig> {
    await this.latency(150, 300)
    return {
      owner_id: 'vedd.testnet',
      gateway_id: 'gateway.vedd.testnet',
      paused: false,
      fees_accrued: this.state.fees,
      next_session_id: String(this.state.nextId),
      storage_reserve: STORAGE_RESERVE.toString(),
      min_amount: MIN_AMOUNT.toString(),
      max_open_sessions: MAX_OPEN_SESSIONS,
      max_receipts: MAX_RECEIPTS,
      min_ttl_seconds: String(MIN_TTL),
      max_ttl_seconds: String(MAX_TTL),
      settle_grace_seconds: String(GRACE_S),
    }
  }

  async getBalance(accountId: string) {
    await this.latency(200, 450)
    return this.balanceView(accountId)
  }

  async getSessions(accountId: string) {
    await this.latency(200, 450)
    return Object.values(this.state.sessions)
      .filter((s) => s.owner === accountId)
      .sort((a, b) => Number(a.session_id) - Number(b.session_id))
  }

  async getReceipts(accountId: string) {
    await this.latency(200, 450)
    return [...(this.state.accounts[accountId]?.receipts ?? [])]
  }

  async getMessages(_accountId: string, sessionId: string) {
    await sleep(120)
    return [...(this.state.messages[sessionId] ?? [])]
  }

  async getProof(_accountId: string, sessionId: string): Promise<TeeAttestation | null> {
    await sleep(120)
    const p = this.state.proofs[sessionId]
    return p?.kind === 'tee' ? p : null
  }

  async getPaymentProof(_accountId: string, sessionId: string): Promise<PaymentProof | null> {
    await sleep(120)
    return this.state.payProofs?.[sessionId] ?? null
  }

  getAssets() {
    return ASSETS
  }

  // ---------- writes (contract rules) ----------

  async deposit(accountId: string, amount: Yocto) {
    await this.latency()
    const amt = BigInt(amount)
    if (amt < MIN_AMOUNT) throw new Error('Deposit at least 0.001 NEAR')
    const a = this.state.accounts[accountId]
    if (a) {
      a.available = (BigInt(a.available) + amt).toString()
    } else {
      if (amt <= STORAGE_RESERVE) throw new Error('First deposit must exceed the 0.05 NEAR storage reserve')
      this.state.accounts[accountId] = {
        available: (amt - STORAGE_RESERVE).toString(),
        locked: '0',
        reserve: STORAGE_RESERVE.toString(),
        receipts: [],
      }
    }
    this.commit()
    return this.balanceView(accountId)!
  }

  async withdraw(accountId: string, amount: Yocto) {
    await this.latency()
    const amt = BigInt(amount)
    if (amt <= 0n) throw new Error('Amount must be positive')
    const a = this.acct(accountId)
    if (amt > BigInt(a.available)) throw new Error('Not enough available credits')
    a.available = (BigInt(a.available) - amt).toString()
    this.commit()
    return this.balanceView(accountId)!
  }

  async unregister(accountId: string) {
    await this.latency()
    const a = this.acct(accountId)
    if (Object.values(this.state.sessions).some((s) => s.owner === accountId)) throw new Error('Close open sessions first')
    if (BigInt(a.locked) > 0n) throw new Error('Credits still locked')
    if (BigInt(a.available) > 0n) throw new Error('Withdraw available credits first')
    delete this.state.accounts[accountId]
    this.commit()
  }

  async openSession(accountId: string, cap: Yocto, ttlSeconds: number, mode: PrivacyMode) {
    await this.latency()
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL || ttlSeconds > MAX_TTL)
      throw new Error('ttl_seconds must be between 60 and 86400')
    const c = BigInt(cap)
    if (c < MIN_AMOUNT) throw new Error('Cap must be at least 0.001 NEAR')
    const a = this.acct(accountId)
    const open = Object.values(this.state.sessions).filter((s) => s.owner === accountId).length
    if (open >= MAX_OPEN_SESSIONS) throw new Error('Too many open sessions')
    if (c > BigInt(a.available)) throw new Error('Not enough available credits')
    a.available = (BigInt(a.available) - c).toString()
    a.locked = (BigInt(a.locked) + c).toString()
    const now = this.nowNs()
    const expires = now + BigInt(ttlSeconds) * 1_000_000_000n
    const id = String(this.state.nextId++)
    const s: SessionInfo = {
      session_id: id,
      owner: accountId,
      cap,
      opened_at: now.toString(),
      expires_at: expires.toString(),
      settle_deadline: (expires + BigInt(GRACE_S) * 1_000_000_000n).toString(),
      mode,
      metered: '0',
    }
    this.state.sessions[id] = s
    this.state.messages[id] = []
    this.commit()
    return { ...s }
  }

  async closeSession(accountId: string, sessionId: string) {
    await this.latency(600, 1200)
    const s = this.ownedSession(accountId, sessionId)
    if (this.nowNs() > BigInt(s.settle_deadline))
      throw new Error('Settlement window has closed. Reclaim the session instead.')
    return this.close(s, BigInt(s.metered), 'Settled')
  }

  async reclaimSession(accountId: string, sessionId: string) {
    await this.latency()
    const s = this.ownedSession(accountId, sessionId)
    if (this.nowNs() <= BigInt(s.settle_deadline))
      throw new Error('Session cannot be reclaimed until its settle deadline passes')
    return this.close(s, 0n, 'Reclaimed')
  }

  // ---------- chat (gateway + NEAR AI Cloud / zkAPI) ----------

  async *chat(accountId: string, sessionId: string, prompt: string, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const s = this.state.sessions[sessionId]
    if (!s || s.owner !== accountId) {
      yield { type: 'error', code: 'SESSION_CLOSED', message: 'This session is closed. Open a new one to keep chatting.' }
      return
    }
    if (this.nowNs() > BigInt(s.expires_at)) {
      yield { type: 'error', code: 'SESSION_EXPIRED', message: 'This session has expired. End it to settle, or open a new one.' }
      return
    }
    const msgs = (this.state.messages[sessionId] ??= [])
    msgs.push({ id: `${sessionId}-${msgs.length}`, role: 'user', content: prompt, at: this.now() })
    this.commit()

    await sleep(500 + Math.random() * 500, signal)
    if (this.failing()) {
      yield { type: 'error', code: 'GATEWAY_DOWN', message: 'The gateway is not responding (simulated). Your credits are safe; try again.' }
      return
    }

    const reply: ChatMessage = { id: `${sessionId}-${msgs.length}`, role: 'assistant', content: '', at: this.now() }
    msgs.push(reply)
    const promptTokens = BigInt(Math.ceil(prompt.length / 4))
    let tokens = 0n
    const cap = BigInt(s.cap)
    const startMetered = BigInt(s.metered)
    const parts = answerFor(prompt, s.mode).split(/(\s+)/)

    for (const part of parts) {
      if (signal?.aborted) break
      if (part.trim()) tokens++
      const cost = (promptTokens + tokens) * YOCTO_PER_TOKEN
      if (startMetered + cost > cap) {
        reply.error = 'Session cap reached'
        s.metered = s.cap
        this.commit()
        yield { type: 'error', code: 'CAP_REACHED', message: 'This session reached its spending cap. End it and open a new one to continue.' }
        return
      }
      reply.content += part
      yield { type: 'token', text: part }
      if (part.trim()) await sleep(18 + Math.random() * 40, signal)
    }

    const cost = (promptTokens + tokens) * YOCTO_PER_TOKEN
    s.metered = (startMetered + cost).toString()
    reply.cost = cost.toString()
    reply.tokens = Number(promptTokens + tokens)
    const tee = this.makeAttestation(s)
    this.state.proofs[sessionId] = tee
    const pay = s.mode === 'A' ? this.makePaymentProof(s) : null
    if (pay) (this.state.payProofs ??= {})[sessionId] = pay
    this.commit()
    yield { type: 'usage', tokens: reply.tokens, cost: reply.cost, metered: s.metered }
    if (pay) yield { type: 'proof', proof: pay }
    yield { type: 'proof', proof: tee }
    yield { type: 'done' }
  }

  private makeAttestation(s: SessionInfo): TeeAttestation {
    const n = (this.state.messages[s.session_id]?.length ?? 0).toString()
    {
      const p: TeeAttestation = {
        kind: 'tee',
        provider: 'NEAR AI Cloud',
        model: 'deepseek-ai/DeepSeek-V3.1',
        hardware: 'Intel TDX + NVIDIA H100 (confidential computing)',
        measurement: mockHex(`mrtd:${s.session_id}`, 48),
        signing_key: `0x${mockHex(`signer:${s.session_id}`, 20)}`,
        nonce: mockHex(`nonce:${s.session_id}:${n}`, 16),
        issued_at: this.now(),
        verified: true,
        verify_url: 'https://docs.near.ai/cloud/verification',
        raw: { mock: true, report: 'TDX quote + NVIDIA GPU evidence would appear here in Level 3' },
      }
      return p
    }
  }

  private makePaymentProof(s: SessionInfo): PaymentProof {
    const n = (this.state.messages[s.session_id]?.length ?? 0).toString()
    const p: PaymentProof = {
      kind: 'zk',
      scheme: 'Simulated (demo account)',
      nullifier: mockHex(`nullifier:${s.session_id}:${n}`),
      proof_bytes: 0,
      key_reuse_window_s: 0,
      verified: false,
      issued_at: this.now(),
      raw: { mock: true, note: 'Demo account: no note was bought and no proof was made. Connect a wallet to pay with a real note and a zero-knowledge proof.' },
    }
    return p
  }

  /** The demo account has no real notes: private payment is simulated here. */
  async getNoteInfo() {
    return null
  }

  // ---------- wallet actions, simulated ----------

  async checkRecipient(to: string): Promise<RecipientStatus> {
    await this.latency(200, 400)
    return /^[0-9a-f]{64}$/.test(to) ? 'implicit' : 'exists'
  }

  async transferNear(accountId: string, sessionId: string, to: string, amount: Yocto, prompt: string): Promise<ChatMessage[]> {
    const s = this.state.sessions[sessionId]
    if (!s || s.owner !== accountId) throw new Error('This session is closed. Open a new one to keep chatting.')
    await this.latency(700, 1300)
    if (this.failing()) throw new Error('Cancelled in the wallet')
    const msgs = (this.state.messages[sessionId] ??= [])
    const added: ChatMessage[] = [
      { id: `${sessionId}-${msgs.length}`, role: 'user', content: prompt, at: this.now(), action: true },
      {
        id: `${sessionId}-${msgs.length + 1}`,
        role: 'assistant',
        content: `Demo account: a wallet would now send ${formatNear(amount, 24)} NEAR to ${to}. Nothing was sent.`,
        at: this.now(),
        action: true,
      },
    ]
    msgs.push(...added)
    this.commit()
    return added
  }

  // ---------- funding (NEAR Intents) ----------

  private quotes: Record<string, IntentsQuote> = {}

  async getQuote(assetId: string, amountIn: string): Promise<IntentsQuote> {
    await this.latency(600, 1200)
    const asset = ASSETS.find((a) => a.id === assetId)
    if (!asset) throw new Error('Unsupported asset')
    if (!/^\d+(\.\d+)?$/.test(amountIn) || Number(amountIn) <= 0) throw new Error('Enter an amount greater than 0')
    const [w, f = ''] = amountIn.split('.')
    const units = BigInt(w) * 10n ** 6n + BigInt(f.padEnd(6, '0').slice(0, 6)) // 6-decimal precision for quotes
    const grossYocto = (units * RATE_E6[assetId] * NEAR) / 10n ** 12n
    const fee = grossYocto / 1000n // 0.1%
    const q: IntentsQuote = {
      quote_id: mockHex(`quote:${assetId}:${amountIn}:${Date.now()}`, 8),
      asset,
      amount_in: amountIn,
      amount_out: (grossYocto - fee).toString(),
      rate: assetId === 'near' ? '1 NEAR = 1 NEAR' : `1 ${asset.symbol} ≈ ${(Number(RATE_E6[assetId]) / 1e6).toFixed(4)} NEAR`,
      fee: fee.toString(),
      expires_at: Date.now() + 30_000,
      dry: true,
      source: 'mock',
    }
    this.quotes[q.quote_id] = q
    return q
  }

  async fundWithQuote(accountId: string, quoteId: string) {
    const q = this.quotes[quoteId]
    if (!q) throw new Error('Quote not found. Get a new quote.')
    if (Date.now() > q.expires_at) throw new Error('Quote expired. Get a new quote.')
    delete this.quotes[quoteId]
    return this.deposit(accountId, q.amount_out)
  }
}
