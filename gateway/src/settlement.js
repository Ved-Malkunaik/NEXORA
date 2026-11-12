// Settlement logic for the Nexora gateway. Pure helpers are exported for tests;
// `createGateway` wires them to a real NEAR account.
import { createHash } from 'node:crypto'
import { Account, JsonRpcProvider, nearToYocto, teraToGas } from 'near-api-js'

/**
 * Hash of the off-chain usage record. Only this hash goes on-chain, never prompts or answers.
 * Keys are sorted so the same record always gives the same hash.
 */
export function receiptHash(record) {
  const canonical = JSON.stringify(record, Object.keys(record).sort())
  return createHash('sha256').update(canonical).digest('hex')
}

/** Convert a NEAR amount given as a string ("0.012") to a yocto string, without floats. */
export function toYocto(near) {
  if (!/^\d+(\.\d{1,24})?$/.test(String(near))) throw new Error(`Invalid NEAR amount: ${near}`)
  return nearToYocto(String(near)).toString()
}

/**
 * Check a settlement against the on-chain session before sending it, so we fail fast with a
 * clear message instead of paying gas for a transaction the contract would reject.
 */
export function validateSettlement(session, spentYocto, nowNs, gatewayId) {
  if (!session) throw new Error('Session not found or already closed')
  if (BigInt(spentYocto) > BigInt(session.cap)) throw new Error('Spent exceeds session cap')
  if (BigInt(nowNs) > BigInt(session.settle_deadline)) throw new Error('Settlement window has closed')
  if (!gatewayId) throw new Error('GATEWAY_ACCOUNT_ID is not set')
}

export function readConfig(env = process.env) {
  const cfg = {
    rpcUrl: env.NEAR_RPC_URL || 'https://rpc.testnet.fastnear.com',
    contractId: env.CONTRACT_ID,
    gatewayId: env.GATEWAY_ACCOUNT_ID,
    privateKey: env.GATEWAY_PRIVATE_KEY,
  }
  if (!cfg.contractId) throw new Error('CONTRACT_ID is not set (see gateway/.env.example)')
  return cfg
}

export function createGateway(cfg = readConfig()) {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl })

  async function getSession(sessionId) {
    return provider.callFunction({
      contractId: cfg.contractId,
      method: 'get_session',
      args: { session_id: String(sessionId) },
    })
  }

  async function getConfig() {
    return provider.callFunction({ contractId: cfg.contractId, method: 'get_config', args: {} })
  }

  /**
   * Settle a session: `spentNear` is charged, the rest of the cap is refunded to the user,
   * and the hash of `usage` is stored as the receipt.
   */
  async function settle(sessionId, spentNear, usage = {}) {
    if (!cfg.privateKey || !cfg.gatewayId) {
      throw new Error('GATEWAY_ACCOUNT_ID and GATEWAY_PRIVATE_KEY are required to settle')
    }
    const spent = toYocto(spentNear)
    const session = await getSession(sessionId)
    validateSettlement(session, spent, BigInt(Date.now()) * 1_000_000n, cfg.gatewayId)

    const record = { session_id: String(sessionId), spent_yocto: spent, settled_at: new Date().toISOString(), ...usage }
    const hash = receiptHash(record)
    const account = new Account(cfg.gatewayId, provider, cfg.privateKey)
    const outcome = await account.callFunction({
      contractId: cfg.contractId,
      methodName: 'settle_session',
      args: { session_id: String(sessionId), spent, receipt_hash: hash },
      gas: teraToGas('30'),
    })
    return { record, receipt_hash: hash, outcome }
  }

  async function getReceipts(accountId) {
    return provider.callFunction({ contractId: cfg.contractId, method: 'get_receipts', args: { account_id: accountId } })
  }

  /** Settle with an exact yocto amount and receipt hash (used by the server). Returns the tx hash. */
  async function settleExact(sessionId, spentYocto, hash) {
    if (!cfg.privateKey || !cfg.gatewayId) {
      throw new Error('GATEWAY_ACCOUNT_ID and GATEWAY_PRIVATE_KEY are not set in gateway/.env')
    }
    const account = new Account(cfg.gatewayId, provider, cfg.privateKey)
    const r = await account.callFunctionRaw({
      contractId: cfg.contractId,
      methodName: 'settle_session',
      args: { session_id: String(sessionId), spent: String(spentYocto), receipt_hash: hash },
      gas: teraToGas('30'),
    })
    const failure = r?.status?.Failure
    if (failure) {
      const msg = JSON.stringify(failure).match(/Smart contract panicked: ([^"\\]+)/)
      throw new Error(msg ? msg[1] : JSON.stringify(failure))
    }
    return { tx: r?.transaction?.hash ?? r?.transaction_outcome?.id }
  }

  return { getSession, getConfig, getReceipts, settle, settleExact }
}
