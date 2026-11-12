// Stand-in model until NEAR AI Cloud is wired (needs an API key). Same interface the real
// provider will have: stream(prompt, mode) yields text chunks; proof(...) returns the proof.
// Everything here is labelled mock so it is never mistaken for a real attestation.
import { createHash } from 'node:crypto'

const ANSWERS = [
  [/medical|report|health|diagnos/i, 'Here is a plain-language summary. The report lists three findings: blood counts within normal range, slightly raised LDL cholesterol, and vitamin D below the reference level. None of these is urgent. Common next steps are a repeat lipid panel in three months and asking your doctor whether a vitamin D supplement makes sense. Bring the original report to that appointment, since only your doctor can interpret it against your history.'],
  [/term sheet|seed|investor|valuation/i, 'A seed term sheet usually covers: amount raised and instrument (priced equity or SAFE), pre-money valuation or cap, option pool size and whether it sits pre- or post-money, liquidation preference (1x non-participating is standard), pro-rata rights, and board composition. Keep it short and non-binding except for confidentiality and exclusivity. Tell me your round size and target valuation and I will draft the clauses.'],
  [/contract|clause|liabilit|indemn/i, 'Watch for four things in a liability clause: an uncapped indemnity, a cap that excludes the obligations most likely to go wrong, consequential-loss carve-outs that swallow the cap, and one-sided survival periods. A balanced version caps liability at fees paid in the last twelve months, makes the cap mutual, and keeps carve-outs to fraud, wilful misconduct and confidentiality breaches. Paste the clause and I will mark it up.'],
  [/tax|staking|reward/i, 'In many jurisdictions staking rewards are taxed as income when you gain control of them, valued at the market price on that day, and again as a capital gain or loss when you later sell. Keep a record of each reward with its date and value. Rules differ a lot by country, so treat this as orientation, not tax advice, and check with a local professional before filing.'],
]

export const MODEL_ID = 'mock-model (NEAR AI Cloud pending)'

export function answerFor(prompt, mode) {
  const hit = ANSWERS.find(([re]) => re.test(prompt))
  if (hit) return hit[1]
  return mode === 'B'
    ? 'Your request reached the Nexora gateway and was metered against your on-chain session cap. Replies are simulated until the NEAR AI Cloud key is configured; then this prompt runs inside a TEE and the panel shows the real attestation.'
    : 'Your request reached the Nexora gateway and was metered against your on-chain session cap. Replies are simulated until zkAPI is wired; then each request is paid with an anonymous credit.'
}

const hex = (s, bytes = 32) => createHash('sha256').update(s).digest('hex').slice(0, bytes * 2)

export function proofFor(sessionId, mode, n) {
  if (mode === 'B')
    return {
      kind: 'tee',
      provider: 'NEAR AI Cloud',
      model: MODEL_ID,
      hardware: 'Intel TDX + NVIDIA H100 (confidential computing)',
      measurement: hex(`mrtd:${sessionId}`, 48),
      signing_key: `0x${hex(`signer:${sessionId}`, 20)}`,
      nonce: hex(`nonce:${sessionId}:${n}`, 16),
      issued_at: Date.now(),
      verified: false,
      verify_url: 'https://docs.near.ai/cloud/verification',
      raw: { mock: true, note: 'Placeholder until the NEAR AI Cloud key is configured on the gateway.' },
    }
  return {
    kind: 'zk',
    scheme: 'zkAPI (Groth16)',
    nullifier: hex(`nullifier:${sessionId}:${n}`),
    proof_bytes: 192,
    key_reuse_window_s: 0,
    verified: false,
    issued_at: Date.now(),
    raw: { mock: true, note: 'Placeholder until zkAPI is wired.' },
  }
}
