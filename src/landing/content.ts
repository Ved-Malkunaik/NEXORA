// All landing-page copy lives here so the layout file stays about layout.

export const TOP_BAR = { strong: 'New:', text: 'Nexora is live on NEAR testnet - Private AI chat you control' }

export const PROMPTS = [
  'Summarize this article in five bullet points.',
  'Draft a seed term sheet for our round.',
  'Review this contract clause for hidden liabilities.',
  'Explain my tax options for staking rewards on NEAR.',
]

export const FEATURES = ['Anonymous payments', 'Zero-knowledge proofs', 'Pay by prompt']

export const HERO = {
  kicker: 'Meet your',
  line1: 'Private',
  line2: 'Assistant',
  sub: 'Chat with open AI models and pay without revealing who you are.',
}

export const PRODUCT_TABS = [
  'Private AI chat',
  'Free open models via OpenRouter',
  'Anonymous note payments',
  'Pay by prompt (private sessions)',
  'Proof viewer',
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
    name: 'Every chat · Open models',
    role: 'OpenRouter · Free models',
    quote: '“Chat with free open models. Your transcript stays in your browser, but the model host can read what you send, so keep secrets out of it.',
  },
  {
    name: 'Private payment · Hide who pays',
    role: 'Notes · Zero-knowledge proofs',
    quote: '“Buy a note, then prove in zero knowledge that you hold a paid one. The gateway can verify the payment without learning whose it is.',
  },
  {
    name: 'Capped sessions',
    role: 'NEAR contract · Refunds',
    quote: '“Lock a spending cap, chat, and reclaim whatever is unspent. Only a receipt hash touches the chain.',
  },
]
