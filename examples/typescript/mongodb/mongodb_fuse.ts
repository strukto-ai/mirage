// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { setServers } from 'node:dns'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { FuseManager, MongoDBResource, MountMode, Workspace } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
setServers(['8.8.8.8', '1.1.1.1'])
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

const DB = 'mirage_test'
const COLL = 'heterogeneous'
const VIEW = 'high_rated_films'

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI
  if (uri === undefined) {
    console.error('MONGODB_URI missing in .env.development')
    process.exit(1)
  }
  const resource = new MongoDBResource({ uri, databases: [DB] })
  const ws = new Workspace({ '/mongodb/': resource }, { mode: MountMode.READ })
  const fm = new FuseManager()
  const mp = await fm.setup(ws)
  let cleaned = false
  const handler = (sig: NodeJS.Signals): void => {
    if (cleaned) return
    cleaned = true
    void (async (): Promise<void> => {
      try {
        await fm.close()
      } catch {}
      try {
        await ws.close()
      } catch {}
      console.error(`\n>>> unmounted ${mp}`)
      process.exit(sig === 'SIGINT' ? 130 : 143)
    })()
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)

  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`)

    console.log('--- listdir() root (databases) ---')
    for (const db of (await readdir(`${mp}/mongodb`)).sort()) console.log(`  ${db}`)

    console.log(`\n--- listdir() /mongodb/${DB} (entities) ---`)
    for (const e of (await readdir(`${mp}/mongodb/${DB}`)).sort()) console.log(`  ${e}`)

    console.log(`\n--- listdir() /mongodb/${DB}/collections ---`)
    for (const c of (await readdir(`${mp}/mongodb/${DB}/collections`)).sort()) console.log(`  ${c}`)

    console.log(`\n--- listdir() /mongodb/${DB}/views ---`)
    for (const v of (await readdir(`${mp}/mongodb/${DB}/views`)).sort()) console.log(`  ${v}`)

    console.log(`\n--- listdir() /mongodb/${DB}/collections/${COLL} (entity) ---`)
    for (const e of (await readdir(`${mp}/mongodb/${DB}/collections/${COLL}`)).sort())
      console.log(`  ${e}`)

    console.log('\n--- open() database.json ---')
    const dbMeta = JSON.parse(await readFile(`${mp}/mongodb/${DB}/database.json`, 'utf8')) as {
      collections: unknown[]
      views: unknown[]
    }
    console.log(`  collections: ${String(dbMeta.collections.length)}`)
    console.log(`  views: ${String(dbMeta.views.length)}`)

    console.log(`\n--- open() schema.json for ${COLL} ---`)
    const schema = JSON.parse(
      await readFile(`${mp}/mongodb/${DB}/collections/${COLL}/schema.json`, 'utf8'),
    ) as { kind: string; fields: unknown[]; indexes: unknown[] }
    console.log(`  kind: ${schema.kind}`)
    console.log(`  fields: ${String(schema.fields.length)}`)
    console.log(`  indexes: ${String(schema.indexes.length)}`)

    console.log(`\n--- open() + read documents.jsonl for ${COLL} ---`)
    const text = (
      await readFile(`${mp}/mongodb/${DB}/collections/${COLL}/documents.jsonl`, 'utf8')
    ).trim()
    const lines = text.split('\n').filter((ln) => ln.trim() !== '')
    console.log(`  documents: ${String(lines.length)}`)
    for (const ln of lines.slice(0, 3)) {
      const doc = JSON.parse(ln) as { title?: string }
      console.log(`  ${doc.title ?? '?'}`)
    }

    console.log(`\n--- open() + read view documents for ${VIEW} ---`)
    const viewText = (
      await readFile(`${mp}/mongodb/${DB}/views/${VIEW}/documents.jsonl`, 'utf8')
    ).trim()
    const viewLines = viewText.split('\n').filter((ln) => ln.trim() !== '')
    console.log(`  documents: ${String(viewLines.length)}`)
    for (const ln of viewLines.slice(0, 3)) {
      const doc = JSON.parse(ln) as { title?: string; rating?: number }
      console.log(`  ${doc.title ?? '?'} (rating=${String(doc.rating ?? '?')})`)
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`)
    console.log('>>> Open another terminal and try:')
    console.log(`>>>   ls ${mp}/mongodb/${DB}/collections/`)
    console.log(`>>>   head -n 3 ${mp}/mongodb/${DB}/collections/${COLL}/documents.jsonl`)
    if (process.stdin.isTTY) {
      console.log('>>> Press Enter to unmount and exit...')
      await new Promise<void>((resolve) => {
        process.stdin.once('data', () => resolve())
      })
    } else {
      console.log('>>> (non-interactive: unmounting now)')
    }
  } finally {
    await fm.close()
    await ws.close()
    await resource.close()
  }
}

await main()
