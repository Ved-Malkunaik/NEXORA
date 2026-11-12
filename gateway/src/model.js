// Fallback replies for when NEARAI_API_KEY is not set, and the Mode A payment-proof placeholder.
// Everything here is labelled so it is never mistaken for a real model answer or a real proof.
import { createHash } from 'node:crypto'

const ANSWERS = [
  [/medical|report|health|diagnos/i, 'Here is a plain-language summary. The report lists three findings: blood counts within normal range, slightly raised LDL cholesterol, and vitamin D below the reference level. None of these is urgent. Common next steps are a repeat lipid panel in three months and asking your doctor whether a vitamin D supplement makes sense. Bring the original report to that appointment, since only your doctor can interpret it against your history.'],
  [/term sheet|seed|investor|valuation/i, 'A seed term sheet usually covers: amount raised and instrument (priced equity or SAFE), pre-money valuation or cap, option pool size and whether it sits pre- or post-money, liquidation preference (1x non-participating is standard), pro-rata rights, and board composition. Keep it short and non-binding except for confidentiality and exclusivity. Tell me your round size and target valuation and I will draft the clauses.'],
  [/contract|clause|liabilit|indemn/i, 'Watch for four things in a liability clause: an uncapped indemnity, a cap that excludes the obligations most likely to go wrong, consequential-loss carve-outs that swallow the cap, and one-sided survival periods. A balanced version caps liability at fees paid in the last twelve months, makes the cap mutual, and keeps carve-outs to fraud, wilful misconduct and confidentiality breaches. Paste the clause and I will mark it up.'],
  [/tax|staking|reward/i, 'In many jurisdictions staking rewards are taxed as income when you gain control of them, valued at the market price on that day, and again as a capital gain or loss when you later sell. Keep a record of each reward with its date and value. Rules differ a lot by country, so treat this as orientation, not tax advice, and check with a local professional before filing.'],
]

export const MOCK_MODEL_ID = 'simulated (no NEARAI_API_KEY on the gateway)'

export function answerFor(prompt) {
  const hit = ANSWERS.find(([re]) => re.test(prompt))
  const body = hit
    ? hit[1]
    : 'Your request reached the Nexora gateway and was metered against your on-chain session cap.'
  return `[Simulated reply: the gateway has no NEAR AI Cloud API key, so no model ran.] ${body}`
}

const hex = (s, bytes = 32) => createHash('sha256').update(s).digest('hex').slice(0, bytes * 2)

/**
 * Mode A placeholder. zkAPI is not integrated in this build: the request is paid from an on-chain
 * session that names your account, so the payer is NOT hidden. The proof says so.
 */
export function paymentPlaceholder(sessionId, n) {
  return {
    kind: 'zk',
    scheme: 'zkAPI (not integrated: preview only)',
    nullifier: hex(`nullifier:${sessionId}:${n}`),
    proof_bytes: 0,
    key_reuse_window_s: 0,
    verified: false,
    issued_at: Date.now(),
    raw: {
      mock: true,
      note: 'No zero-knowledge proof was produced. This request was paid from on-chain session ' + sessionId + ', which is linked to your account. Mode A does not hide the payer yet.',
    },
  }
}
