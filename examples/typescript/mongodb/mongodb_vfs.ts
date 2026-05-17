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
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { MongoDBResource, MountMode, Workspace } from '@struktoai/mirage-node'

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

  try {
    console.log('=== VFS MODE: open() reads from MongoDB ===\n')

    console.log('--- listdir() root (databases) ---')
    for (const db of await ws.fs.readdir('/mongodb')) console.log(`  ${db}`)

    console.log(`\n--- listdir() /mongodb/${DB} (entities) ---`)
    for (const e of await ws.fs.readdir(`/mongodb/${DB}`)) console.log(`  ${e}`)

    console.log(`\n--- listdir() /mongodb/${DB}/collections ---`)
    for (const c of await ws.fs.readdir(`/mongodb/${DB}/collections`)) console.log(`  ${c}`)

    console.log(`\n--- listdir() /mongodb/${DB}/views ---`)
    for (const v of await ws.fs.readdir(`/mongodb/${DB}/views`)) console.log(`  ${v}`)

    console.log(`\n--- listdir() /mongodb/${DB}/collections/${COLL} (entity) ---`)
    for (const e of await ws.fs.readdir(`/mongodb/${DB}/collections/${COLL}`)) console.log(`  ${e}`)

    console.log('\n--- open() database.json ---')
    const dbMeta = JSON.parse(await ws.fs.readFileText(`/mongodb/${DB}/database.json`)) as {
      collections: unknown[]
      views: unknown[]
    }
    console.log(`  collections: ${String(dbMeta.collections.length)}`)
    console.log(`  views: ${String(dbMeta.views.length)}`)

    console.log(`\n--- open() schema.json for ${COLL} ---`)
    const schema = JSON.parse(
      await ws.fs.readFileText(`/mongodb/${DB}/collections/${COLL}/schema.json`),
    ) as { kind: string; fields: unknown[]; indexes: unknown[] }
    console.log(`  kind: ${schema.kind}`)
    console.log(`  fields: ${String(schema.fields.length)}`)
    console.log(`  indexes: ${String(schema.indexes.length)}`)

    console.log(`\n--- open() + read documents.jsonl for ${COLL} ---`)
    const content = await ws.fs.readFileText(
      `/mongodb/${DB}/collections/${COLL}/documents.jsonl`,
    )
    const lines = content.trim().split('\n').filter((ln) => ln.trim() !== '')
    console.log(`  documents: ${String(lines.length)}`)
    for (const ln of lines.slice(0, 3)) {
      const doc = JSON.parse(ln) as { _id: { $oid?: string }; title?: string }
      console.log(`  [${doc._id.$oid ?? '?'}] ${doc.title ?? '?'}`)
    }

    console.log(`\n--- open() + read view documents for ${VIEW} ---`)
    const viewContent = await ws.fs.readFileText(
      `/mongodb/${DB}/views/${VIEW}/documents.jsonl`,
    )
    const viewLines = viewContent.trim().split('\n').filter((ln) => ln.trim() !== '')
    console.log(`  documents: ${String(viewLines.length)}`)
    for (const ln of viewLines.slice(0, 3)) {
      const doc = JSON.parse(ln) as { title?: string; rating?: number }
      console.log(`  ${doc.title ?? '?'} (rating=${String(doc.rating ?? '?')})`)
    }

  } finally {
    await ws.close()
    await resource.close()
  }
}

await main()
