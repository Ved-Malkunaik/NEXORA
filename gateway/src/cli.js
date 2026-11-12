#!/usr/bin/env node
// Usage:
//   npm run session -- <session_id>                 show an open session
//   npm run settle  -- <session_id> <spent_NEAR>    settle it (gateway key required)
import { createGateway } from './settlement.js'

const [cmd, id, spent] = process.argv.slice(2)

try {
  const gw = createGateway()
  if (cmd === 'session' && id) {
    console.log(JSON.stringify(await gw.getSession(id), null, 2) ?? 'null')
  } else if (cmd === 'settle' && id && spent) {
    const { receipt_hash, record } = await gw.settle(id, spent, { source: 'cli' })
    console.log(`Settled session ${id}: spent ${spent} NEAR`)
    console.log(`receipt_hash ${receipt_hash}`)
    console.log(`record ${JSON.stringify(record)}`)
  } else {
    console.error('Usage: cli.js session <id> | settle <id> <spent_NEAR>')
    process.exitCode = 2
  }
} catch (e) {
  console.error(`Error: ${e instanceof Error ? e.message : e}`)
  process.exitCode = 1
}
