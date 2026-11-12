// Must be the first import in main.tsx. NEAR's transaction library (@near-js/transactions)
// and some wallet SDKs use Node's Buffer, which browsers do not have.
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: typeof Buffer }
if (!g.Buffer) g.Buffer = Buffer
