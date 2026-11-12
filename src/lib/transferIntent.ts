// Reads a plain-language transfer request ("send 0.001 NEAR to vedd.near") in the browser.
// Deliberately a strict parser, not a language model: money only moves when the amount and the
// recipient are unambiguous, and the user confirms both before the wallet opens.
// Self-contained (no imports) so it can be unit-tested directly from gateway/test.

export interface TransferIntent {
  /** Recipient account id, lowercased. */
  to: string
  /** Amount in yoctoNEAR. */
  yocto: string
  /** Amount as the user wrote it, normalised ("0.001"). */
  amount: string
}

export type TransferParse = { kind: 'none' } | { kind: 'transfer'; intent: TransferIntent } | { kind: 'invalid'; reason: string }

const VERB = '(?:send|transfer|pay|give|move)'
const AMOUNT = '(\\d+(?:[.,]\\d+)?|[.,]\\d+)'
const UNIT = '(?:near|Ⓝ)(?:\\s+tokens?)?'
// Anything that could be meant as an account; validated properly below.
const ACCOUNT = '(@?[a-z0-9._-]+)'

const AMOUNT_FIRST = new RegExp(`\\b${VERB}\\s+${AMOUNT}\\s*${UNIT}\\s+to\\s+${ACCOUNT}`, 'i')
const ACCOUNT_FIRST = new RegExp(`\\b${VERB}\\s+${ACCOUNT}\\s+${AMOUNT}\\s*${UNIT}`, 'i')
/** Questions about transfers go to the model, they are not instructions. */
const QUESTION = /^\s*(how|what|why|when|where|who|which|should|is|are|does|do|did|explain|tell me)\b|\?\s*$/i

/** NEAR account id rules: 2–64 chars, lowercase alphanumerics separated by single . _ or - */
export function isValidAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id)
}

/** Decimal NEAR string -> yocto string, without floats. Null when malformed or over 24 decimals. */
export function nearToYocto(amount: string): string | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(amount)
  if (!m || (!m[1] && !m[2])) return null
  const frac = m[2] ?? ''
  if (frac.length > 24) return null
  return (BigInt(m[1] || '0') * 10n ** 24n + BigInt(frac.padEnd(24, '0'))).toString()
}

export function parseTransfer(prompt: string): TransferParse {
  if (QUESTION.test(prompt)) return { kind: 'none' }
  let rawAmount: string | undefined
  let rawTo: string | undefined
  const a = AMOUNT_FIRST.exec(prompt)
  if (a) [, rawAmount, rawTo] = a
  else {
    const b = ACCOUNT_FIRST.exec(prompt)
    if (b) [, rawTo, rawAmount] = b
  }
  if (!rawAmount || !rawTo) return { kind: 'none' }

  const to = rawTo.replace(/^@/, '').replace(/[.]+$/, '').toLowerCase()
  if (!isValidAccountId(to)) return { kind: 'invalid', reason: `"${to}" is not a valid NEAR account name.` }
  const amount = rawAmount.replace(',', '.').replace(/^\./, '0.')
  const yocto = nearToYocto(amount)
  if (!yocto) return { kind: 'invalid', reason: 'NEAR amounts have at most 24 decimal places.' }
  if (BigInt(yocto) === 0n) return { kind: 'invalid', reason: 'The amount must be greater than 0.' }
  return { kind: 'transfer', intent: { to, yocto, amount } }
}
