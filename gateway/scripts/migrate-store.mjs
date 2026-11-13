#!/usr/bin/env node
// Copy the gateway's state from the old JSON files (gateway/.data/metering.json, session-keys.json,
// notes.json) into the store the gateway now uses: Upstash Redis if KV_REST_API_URL/KV_REST_API_TOKEN
// (or UPSTASH_REDIS_REST_*) are set, otherwise gateway/.data/store.json.
//
//   node --env-file=.env scripts/migrate-store.mjs            dry run: shows what would be copied
//   node --env-file=.env scripts/migrate-store.mjs --write    copy it
//
// Safe to run twice: notes already in the target are skipped, nothing is deleted.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { storeFromEnv } from '../src/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const DATA = join(here, '..', '.data')
const write = process.argv.includes('--write')
const read = (name, fallback) => {
  try {
    return JSON.parse(readFileSync(join(DATA, name), 'utf8'))
  } catch {
    return fallback
  }
}

const metering = read('metering.json', {})
const keys = read('session-keys.json', {})
const notes = read('notes.json', { leaves: [], nullifiers: {}, sessions: {} })
const store = storeFromEnv(process.env, join(DATA, 'store.json'))

const existing = new Set((await store.lrange('notes:leaves')).map((l) => l.commitment))
const newLeaves = (notes.leaves ?? []).filter((l) => !existing.has(l.commitment))
const liveAnon = Object.entries(notes.sessions ?? {}).filter(([, r]) => r.expires_at > Date.now())

console.log(`target: ${store.kind}`)
console.log(`  paid notes:            ${newLeaves.length} to add (${existing.size} already there)`)
console.log(`  spent-note markers:    ${Object.keys(notes.nullifiers ?? {}).length}`)
console.log(`  open anonymous:        ${liveAnon.length}`)
console.log(`  metered sessions:      ${Object.keys(metering).length}`)
console.log(`  session chat keys:     ${Object.keys(keys).length}`)
if (!write) {
  console.log('\nDry run. Add --write to copy.')
  process.exit(0)
}

for (const l of newLeaves) {
  await store.rpush('notes:leaves', l)
  await store.set(`notes:commitment:${l.commitment}`, String(l.session_id))
  if (l.session_id) await store.set(`notes:sold:${l.session_id}`, l.commitment)
}
for (const [n, at] of Object.entries(notes.nullifiers ?? {})) await store.set(`notes:nullifier:${n}`, at, { nx: true })
for (const [id, rec] of liveAnon) await store.set(`anon:${id}`, rec, { px: rec.expires_at - Date.now() })
for (const [id, m] of Object.entries(metering)) {
  await store.set(`meter:${id}`, m)
  await store.sadd('meter:ids', id)
}
for (const [id, k] of Object.entries(keys)) await store.set(`chatkey:${id}`, k)
console.log('\nCopied.')
