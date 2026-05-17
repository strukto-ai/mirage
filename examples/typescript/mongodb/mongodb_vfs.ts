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
import dotenv from 'dotenv'
import { MongoDBResource, MountMode, Workspace } from '@struktoai/mirage-node'

setServers(['8.8.8.8', '1.1.1.1'])
dotenv.config({ path: '.env.development' })

const uri = process.env.MONGODB_URI
if (uri === undefined) {
  console.error('MONGODB_URI missing in .env.development')
  process.exit(1)
}

const DB = 'mirage_test'
const COLL = 'heterogeneous'
const VIEW = 'high_rated_films'

const DEC = new TextDecoder()

async function dump(ws: Workspace, label: string, cmd: string): Promise<void> {
  console.log(`\n--- ${label} ---`)
  const r = await ws.execute(cmd)
  if (r.exitCode !== 0) {
    console.log(`(exit=${String(r.exitCode)}) ${DEC.decode(r.stderr)}`)
    return
  }
  const out = DEC.decode(r.stdout)
  for (const ln of out.trimEnd().split('\n').slice(0, 8)) console.log(`  ${ln.slice(0, 160)}`)
}

async function main(): Promise<void> {
  const resource = new MongoDBResource({
    uri,
    databases: [DB],
  })
  const ws = new Workspace({ '/mongodb/': resource }, { mode: MountMode.READ })

  try {
    console.log('=== VFS MODE: shell pipelines transparently read MongoDB ===')

    const base = `/mongodb/${DB}`
    const collDoc = `${base}/collections/${COLL}/documents.jsonl`
    const collSchema = `${base}/collections/${COLL}/schema.json`
    const viewDoc = `${base}/views/${VIEW}/documents.jsonl`

    await dump(ws, 'listdir root', 'ls /mongodb/')
    await dump(ws, `listdir ${base}/`, `ls ${base}/`)
    await dump(ws, `listdir ${base}/collections/`, `ls ${base}/collections/`)
    await dump(ws, `listdir ${base}/views/`, `ls ${base}/views/`)
    await dump(
      ws,
      `listdir ${base}/collections/${COLL}/ (entity)`,
      `ls ${base}/collections/${COLL}/`,
    )

    await dump(ws, `cat ${base}/database.json`, `cat ${base}/database.json`)
    await dump(ws, `cat schema.json for ${COLL}`, `cat ${collSchema}`)
    await dump(ws, `head -n 3 documents.jsonl`, `head -n 3 ${collDoc}`)
    await dump(ws, `wc -l documents.jsonl`, `wc -l ${collDoc}`)
    await dump(ws, `head -n 2 view documents`, `head -n 2 ${viewDoc}`)
    await dump(ws, `jq titles`, `jq -r ".[] | .title" ${collDoc} | head -n 5`)
  } finally {
    await ws.close()
    await resource.close()
  }
}

await main()
