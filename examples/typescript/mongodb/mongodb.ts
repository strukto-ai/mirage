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

const uri = process.env.MONGODB_URI
if (uri === undefined) {
  console.error('MONGODB_URI missing in .env.development')
  process.exit(1)
}

const DB = 'mirage_test'
const COLL_HET = 'heterogeneous'
const COLL_EMB = 'embeddings'
const COLL_TXT = 'text_indexed'
const VIEW = 'high_rated_films'

const resource = new MongoDBResource({
  uri,
  databases: [DB],
  elideFields: { [`${DB}.${COLL_EMB}`]: ['vector'] },
})
const ws = new Workspace({ '/mongodb': resource }, { mode: MountMode.READ })

const DEC = new TextDecoder()

async function run(cmd: string): Promise<void> {
  console.log(`\n>>> ${cmd}`)
  const r = await ws.execute(cmd)
  const out = DEC.decode(r.stdout).trimEnd()
  const err = DEC.decode(r.stderr).trimEnd()
  if (out !== '') {
    const lines = out.split('\n')
    for (const ln of lines.slice(0, 8)) console.log(`  ${ln.slice(0, 160)}`)
    if (lines.length > 8) console.log(`  ... (${String(lines.length)} lines total)`)
  }
  if (err !== '') console.log(`  [stderr] ${err.slice(0, 160)}`)
  if (out === '' && err === '') console.log(`  (empty, exit=${String(r.exitCode)})`)
}

const collDoc = `/mongodb/${DB}/collections/${COLL_HET}/documents.jsonl`
const collSchema = `/mongodb/${DB}/collections/${COLL_HET}/schema.json`
const embDoc = `/mongodb/${DB}/collections/${COLL_EMB}/documents.jsonl`
const textDoc = `/mongodb/${DB}/collections/${COLL_TXT}/documents.jsonl`
const viewDoc = `/mongodb/${DB}/views/${VIEW}/documents.jsonl`
const viewSchema = `/mongodb/${DB}/views/${VIEW}/schema.json`
const dbJson = `/mongodb/${DB}/database.json`

try {
  console.log('='.repeat(60))
  console.log('DIRECTORY LISTING')
  console.log('='.repeat(60))
  await run('ls /mongodb/')
  await run(`ls /mongodb/${DB}/`)
  await run(`ls /mongodb/${DB}/collections/`)
  await run(`ls /mongodb/${DB}/views/`)
  await run(`ls /mongodb/${DB}/collections/${COLL_HET}/`)
  await run(`tree -L 3 /mongodb/${DB}/`)

  console.log('\n' + '='.repeat(60))
  console.log('CAT (database.json, schema.json, documents.jsonl)')
  console.log('='.repeat(60))
  await run(`cat "${dbJson}"`)
  await run(`cat "${collSchema}"`)
  await run(`cat "${viewSchema}"`)

  console.log('\n' + '='.repeat(60))
  console.log('HEAD / TAIL / WC / STAT')
  console.log('='.repeat(60))
  await run(`head -n 3 "${collDoc}"`)
  await run(`tail -n 3 "${collDoc}"`)
  await run(`wc -l "${collDoc}"`)
  await run(`stat "${collDoc}"`)
  await run(`head -n 2 "${viewDoc}"`)

  console.log('\n' + '='.repeat(60))
  console.log('ELIDE_FIELDS in action (embedding dropped from output)')
  console.log('='.repeat(60))
  await run(`head -n 1 "${embDoc}"`)

  console.log('\n' + '='.repeat(60))
  console.log('GREP at every scope')
  console.log('='.repeat(60))
  await run(`grep -c title "${collDoc}"`)
  await run(`grep -m 3 title "${collDoc}"`)
  await run(`grep mongodb "/mongodb/${DB}/collections/${COLL_TXT}/"`)
  await run(`grep mongodb "/mongodb/${DB}/"`)
  await run('grep mongodb "/mongodb/"')

  console.log('\n' + '='.repeat(60))
  console.log('RG at db / root scope')
  console.log('='.repeat(60))
  await run(`rg database "/mongodb/${DB}/"`)
  await run('rg database "/mongodb/"')

  console.log('\n' + '='.repeat(60))
  console.log('JQ on documents.jsonl')
  console.log('='.repeat(60))
  await run(`jq -r ".[] | .title" "${collDoc}" | head -n 5`)
  await run(`jq -r '.[] | ._id["$oid"]' "${collDoc}" | head -n 5`)
  await run(`jq -r ".[] | select(.year >= 2024) | .title" "${collDoc}" | head -n 5`)
  await run(`jq -r ".[] | .body" "${textDoc}" | head -n 3`)

  console.log('\n' + '='.repeat(60))
  console.log('FIND')
  console.log('='.repeat(60))
  await run(`find "/mongodb/${DB}/" -name "schema.json"`)
  await run(`find "/mongodb/${DB}/" -name "documents.jsonl"`)
  await run(`find "/mongodb/${DB}/" -maxdepth 2`)

  console.log('\n' + '='.repeat(60))
  console.log('CD + pwd + ls + relative path read')
  console.log('='.repeat(60))
  await ws.execute(`cd "/mongodb/${DB}/collections/${COLL_HET}"`)
  await run('pwd')
  await run('ls')
  await run('head -n 1 documents.jsonl')
} finally {
  await ws.close()
  await resource.close()
}
