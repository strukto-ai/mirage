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

const resource = new MongoDBResource({
  uri,
  databases: [DB],
  elideFields: { [`${DB}.embeddings`]: ['vector'] },
})
const ws = new Workspace({ '/mongodb/': resource }, { mode: MountMode.READ })

const DEC = new TextDecoder()

async function run(cmd: string): Promise<void> {
  console.log(`\n>>> ${cmd}`)
  const r = await ws.execute(cmd)
  const out = DEC.decode(r.stdout).trimEnd()
  const err = DEC.decode(r.stderr).trimEnd()
  if (out !== '') {
    const lines = out.split('\n').slice(0, 8)
    for (const ln of lines) console.log(`  ${ln.slice(0, 160)}`)
    const total = out.split('\n').length
    if (total > 8) console.log(`  ... (${String(total)} lines total)`)
  }
  if (err !== '') console.log(`  [stderr] ${err.slice(0, 160)}`)
  if (out === '' && err === '') console.log(`  (empty, exit=${String(r.exitCode)})`)
}

const base = `/mongodb/${DB}`
const collDoc = `${base}/collections/${COLL}/documents.jsonl`
const collSchema = `${base}/collections/${COLL}/schema.json`
const emb = `${base}/collections/embeddings/documents.jsonl`
const viewDoc = `${base}/views/${VIEW}/documents.jsonl`
const dbJson = `${base}/database.json`

try {
  console.log('============================================================')
  console.log('DIRECTORY LISTING')
  console.log('============================================================')
  await run('ls /mongodb/')
  await run(`ls ${base}/`)
  await run(`ls ${base}/collections/`)
  await run(`ls ${base}/views/`)
  await run(`ls ${base}/collections/${COLL}/`)
  await run(`tree -L 3 ${base}/`)

  console.log('\n============================================================')
  console.log('CAT (database.json, schema.json, documents.jsonl)')
  console.log('============================================================')
  await run(`cat ${dbJson}`)
  await run(`cat ${collSchema}`)

  console.log('\n============================================================')
  console.log('HEAD / TAIL / WC / STAT')
  console.log('============================================================')
  await run(`head -n 3 ${collDoc}`)
  await run(`tail -n 3 ${collDoc}`)
  await run(`wc -l ${collDoc}`)
  await run(`stat ${collDoc}`)
  await run(`head -n 2 ${viewDoc}`)

  console.log('\n============================================================')
  console.log('ELIDE_FIELDS in action (vector dropped from embeddings)')
  console.log('============================================================')
  await run(`head -n 1 ${emb}`)

  console.log('\n============================================================')
  console.log('GREP / RG at every scope')
  console.log('============================================================')
  await run(`grep -c title ${collDoc}`)
  await run(`grep mongodb ${base}/collections/text_indexed/`)
  await run(`grep mongodb ${base}/`)
  await run('grep mongodb /mongodb/')
  await run(`rg database ${base}/`)

  console.log('\n============================================================')
  console.log('JQ on documents.jsonl')
  console.log('============================================================')
  await run(`jq -r ".[] | .title" ${collDoc} | head -n 5`)

  console.log('\n============================================================')
  console.log('FIND')
  console.log('============================================================')
  await run(`find ${base}/ -name "schema.json"`)
  await run(`find ${base}/ -name "documents.jsonl"`)
} finally {
  await ws.close()
  await resource.close()
}
