// The one interface the UI talks to. Level 2 runs it on MockClient; Level 3 swaps in a
// live implementation (contract via wallet selector + gateway + NEAR AI Cloud + Intents)
// without touching the screens. Shapes mirror the deployed contract's JSON exactly.

/** NEAR amount in yoctoNEAR, as the contract's JSON returns it. */
export type Yocto = string
/** Nanosecond timestamp, as the contract's JSON returns it (U64 string). */
export type Nanos = string

/**
 * How a session is paid. Every chat runs in a TEE either way.
 * B: from your credits, an on-chain session linked to your account.
 * A: privately, with a prepaid note and a zero-knowledge proof (no account sent to the gateway).
 */
export type PrivacyMode = 'A' | 'B'

export interface ContractConfig {
  owner_id: string
  gateway_id: string
  paused: boolean
  fees_accrued: Yocto
  next_session_id: string
  storage_reserve: Yocto
  min_amount: Yocto
  max_open_sessions: number
  max_receipts: number
  min_ttl_seconds: string
  max_ttl_seconds: string
  settle_grace_seconds: string
}

/** `get_balance`; null when the account has never deposited. */
export interface CreditBalance {
  available: Yocto
  locked: Yocto
  storage_reserve: Yocto
  open_sessions: string[]
}

/** `get_session` plus what the gateway knows: mode and metered spend so far. */
export interface SessionInfo {
  session_id: string
  owner: string
  cap: Yocto
  opened_at: Nanos
  expires_at: Nanos
  settle_deadline: Nanos
  mode: PrivacyMode
  /** Cost metered by the gateway so far (off-chain until settlement). */
  metered: Yocto
}

/** `get_receipts` entry. */
export interface Receipt {
  session_id: string
  cap: Yocto
  spent: Yocto
  refunded: Yocto
  receipt_hash: string | null
  closed_at: Nanos
  outcome: 'Settled' | 'Reclaimed'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  at: number
  cost?: Yocto
  tokens?: number
  error?: string
  /** Set on the reply to a wallet action (a NEAR transfer): the transaction hash, if the wallet returned one. */
  tx?: string
  /** True for wallet-action messages: they never went to the gateway or a model. */
  action?: boolean
}

/** Does the recipient of a transfer exist on this network? 'unknown' when the RPC could not say. */
export type RecipientStatus = 'exists' | 'missing' | 'implicit' | 'unknown'

/** Proof that the model ran in a TEE (every session). */
export interface TeeAttestation {
  kind: 'tee'
  provider: string
  model: string
  hardware: string
  measurement: string
  signing_key: string
  nonce: string
  issued_at: number
  verified: boolean
  verify_url: string
  /** Each check the gateway ran; `verified` is true only when all pass. */
  checks?: ProofCheck[]
  /** The provider's signature over this exact request + response (real replies only). */
  response_signature?: { chat_id: string; kind: string | null; text: string; signature: string; signing_address: string }
  raw: Record<string, unknown>
}

export interface ProofCheck {
  name: string
  ok: boolean
  detail: string
}

/** Proof that a private session was paid for without revealing the payer. */
export interface PaymentProof {
  kind: 'zk'
  scheme: string
  nullifier: string
  proof_bytes: number
  key_reuse_window_s: number
  verified: boolean
  issued_at: number
  /** How many paid notes this one hides among. Small numbers hide little. */
  anonymity_set?: number
  /** Each check the gateway ran on the zero-knowledge proof. */
  checks?: ProofCheck[]
  raw: Record<string, unknown>
}

/** Private-payment notes on the live gateway: fixed price, and what this browser holds. */
export interface NoteInfo {
  price: Yocto
  tokens: number
  /** Notes sold so far: the crowd a note hides in. */
  pool: number
  /** Paid notes in this browser that have not been spent. */
  unspent: number
  /** When the oldest unspent note was bought (ms), if any. */
  oldest_unspent_at: number | null
}

/** Where a reply came from when it did not run in a TEE (e.g. OpenRouter). Nothing to verify. */
export interface RouteInfo {
  kind: 'route'
  /** 'OpenRouter', or 'Simulated' when no model ran. */
  provider: string
  model: string
  /** The company that actually ran the model, when OpenRouter says. */
  host: string | null
  tee: false
  issued_at: number
  /** Plain statement of what this means for privacy. */
  note: string
  raw: Record<string, unknown>
}

export type Proof = TeeAttestation | PaymentProof | RouteInfo

export type ChatErrorCode = 'CAP_REACHED' | 'SESSION_EXPIRED' | 'GATEWAY_DOWN' | 'SESSION_CLOSED'

export type ChatEvent =
  | { type: 'token'; text: string }
  | { type: 'usage'; tokens: number; cost: Yocto; metered: Yocto }
  | { type: 'proof'; proof: Proof }
  | { type: 'error'; code: ChatErrorCode; message: string }
  | { type: 'done' }

export interface IntentsAsset {
  id: string
  symbol: string
  chain: string
  decimals: number
}

/** NEAR Intents dry-run quote: what you send, what lands as credits. */
export interface IntentsQuote {
  quote_id: string
  asset: IntentsAsset
  amount_in: string
  amount_out: Yocto
  rate: string
  fee: Yocto
  expires_at: number
  dry: boolean
  /** Where the price came from: the live 1Click API, a direct NEAR deposit, or the mock. */
  source?: '1click' | 'direct' | 'mock'
}

export interface NexoraClient {
  readonly kind: 'mock' | 'live'
  /** Bumps on every state change; screens re-query when it changes. */
  subscribe(listener: () => void): () => void
  getVersion(): number

  getConfig(): Promise<ContractConfig>
  getBalance(accountId: string): Promise<CreditBalance | null>
  getSessions(accountId: string): Promise<SessionInfo[]>
  getReceipts(accountId: string): Promise<Receipt[]>

  deposit(accountId: string, amount: Yocto): Promise<CreditBalance>
  withdraw(accountId: string, amount: Yocto): Promise<CreditBalance>
  /** Close an empty credits account and get the 0.05 NEAR storage reserve back. */
  unregister(accountId: string): Promise<void>
  openSession(accountId: string, cap: Yocto, ttlSeconds: number, mode: PrivacyMode): Promise<SessionInfo>
  /** Ask the gateway to settle at the metered cost; the rest is refunded. */
  closeSession(accountId: string, sessionId: string): Promise<Receipt>
  /** Owner-only fallback after the settle deadline: full cap back. */
  reclaimSession(accountId: string, sessionId: string): Promise<Receipt>

  getMessages(accountId: string, sessionId: string): Promise<ChatMessage[]>
  chat(accountId: string, sessionId: string, prompt: string, signal?: AbortSignal): AsyncIterable<ChatEvent>
  /** Latest TEE attestation for a session (every session). */
  getProof(accountId: string, sessionId: string): Promise<TeeAttestation | RouteInfo | null>
  /** Latest payment proof for a privately paid session. */
  getPaymentProof(accountId: string, sessionId: string): Promise<PaymentProof | null>

  /** Private-payment note details, or null where notes are not available (the demo account). */
  getNoteInfo(): Promise<NoteInfo | null>
  /** Check a transfer recipient before the wallet opens. */
  checkRecipient(accountId: string): Promise<RecipientStatus>
  /**
   * Send NEAR from the user's wallet to `to` (wallet popup; public on-chain) and record the request and
   * the outcome in the session transcript. Does not touch credits, the gateway or a model.
   */
  transferNear(accountId: string, sessionId: string, to: string, amount: Yocto, prompt: string): Promise<ChatMessage[]>

  getAssets(): IntentsAsset[]
  getQuote(assetId: string, amountIn: string): Promise<IntentsQuote>
  fundWithQuote(accountId: string, quoteId: string): Promise<CreditBalance>
}
