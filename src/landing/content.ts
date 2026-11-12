// All landing-page copy lives here so the layout file stays about layout.

export const TOP_BAR = { strong: 'New:', text: 'Nexora is live on NEAR testnet - Private AI chat you control' }

export const PROMPTS = [
  'Summarize my medical report without anyone reading it.',
  'Draft a confidential term sheet for our seed round.',
  'Review this contract clause for hidden liabilities.',
  'Explain my tax options for staking rewards on NEAR.',
]

export const FEATURES = ['Private inference', 'TEE attestation', 'Anonymous credits']

export const HERO = {
  kicker: 'Meet your',
  line1: 'Private',
  line2: 'Assistant',
  sub: 'Choose what stays private: who pays, what you ask, or both.',
}

export const PRODUCT_TABS = [
  'Private AI chat',
  'TEE inference (Mode B)',
  'Anonymous payments (Mode A)',
  'Attestation viewer',
  'Capped chat sessions',
  'Prepaid NEAR credits',
  'NEAR Intents funding',
  'On-chain receipt hashes',
  'One-tap session keys',
  'Private AI chat', // duplicate of the first, for a seamless loop
]

export const PRODUCT = { line1: 'Your Gateway', line2: 'To Private AI' }

export interface PrivacyPromise {
  name: string
  role: string
  quote: string
}

/** Section 3: how each privacy promise works (not testimonials). */
export const PROMISES: PrivacyPromise[] = [
  {
    name: 'Mode B · Hide what you ask',
    role: 'NEAR AI Cloud · TEE',
    quote: '“Your prompt runs inside a secure enclave, and every answer comes with an attestation you can check.',
  },
  {
    name: 'Mode A · Hide who pays',
    role: 'Notes · Zero-knowledge proofs',
    quote: '“Buy a note, then prove in zero knowledge that you hold a paid one. The gateway can verify the payment without learning whose it is.',
  },
  {
    name: 'Capped sessions',
    role: 'NEAR contract · Refunds',
    quote: '“Lock a spending cap, chat, and reclaim whatever is unspent. Only a receipt hash touches the chain.',
  },
]
