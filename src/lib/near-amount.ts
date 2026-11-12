// NEAR amounts as yocto strings/bigints. No floats anywhere money is handled.

export const YOCTO_PER_NEAR = 10n ** 24n

/** "0.25" -> 250000000000000000000000n. Throws on malformed input. */
export function parseNear(input: string): bigint {
  const s = input.trim()
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') throw new Error('Enter an amount like 0.25')
  const [whole, frac = ''] = s.split('.')
  if (frac.length > 24) throw new Error('Too many decimal places')
  return BigInt(whole || '0') * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, '0'))
}

/** Safe variant for live validation: null when not parseable. */
export function tryParseNear(input: string): bigint | null {
  try {
    return parseNear(input)
  } catch {
    return null
  }
}

/** 140000000000000000000000 -> "0.14" (trailing zeros trimmed, max `decimals`). */
export function formatNear(yocto: string | bigint, decimals = 4): string {
  const v = typeof yocto === 'bigint' ? yocto : BigInt(yocto)
  const neg = v < 0n
  const a = neg ? -v : v
  const whole = a / YOCTO_PER_NEAR
  const frac = (a % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, decimals).replace(/0+$/, '')
  const out = frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US')
  return neg ? `-${out}` : out
}

/** Fraction a/b in [0,1] for progress bars. */
export function ratio(a: string | bigint, b: string | bigint): number {
  const x = BigInt(a)
  const y = BigInt(b)
  if (y <= 0n) return 0
  return Math.min(1, Number((x * 10_000n) / y) / 10_000)
}
