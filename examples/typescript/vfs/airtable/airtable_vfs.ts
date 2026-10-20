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

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  AirtableVFS,
  MountMode,
  Workspace,
  patchNodeFs,
  type AirtableConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

interface BaseMeta {
  base_name: string
  tables: { table_name: string; table_id: string }[]
}

interface RecordRow {
  record_id: string
  fields: Record<string, unknown>
}

function buildConfig(): AirtableConfig {
  const token = process.env.AIRTABLE_TOKEN
  if (token === undefined || token === '') {
    throw new Error('AIRTABLE_TOKEN env var is required')
  }
  return { token }
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/airtable/': new AirtableVFS(buildConfig()) }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE ===\n')
    const bases = await fs.promises.readdir('/airtable/bases')
    console.log('--- fs.readdir() bases ---')
    for (const name of bases.slice(0, 5)) {
      console.log(`  ${name}`)
    }
    const firstBase = bases[0]
    if (firstBase === undefined) return
    const base = `/airtable/bases/${firstBase}`
    const meta = JSON.parse(await fs.promises.readFile(`${base}/base.json`, 'utf-8')) as BaseMeta
    console.log(`\n--- ${meta.base_name}: ${String(meta.tables.length)} table(s) ---`)
    for (const table of meta.tables) {
      console.log(`  ${table.table_name} (${table.table_id})`)
    }
    const tables = (await fs.promises.readdir(base)).filter((n) => n !== 'base.json')
    const firstTable = tables[0]
    if (firstTable === undefined) return
    console.log(`\n--- first records of ${firstTable} ---`)
    const records = await fs.promises.readFile(`${base}/${firstTable}/records.jsonl`, 'utf-8')
    for (const line of records.split('\n').slice(0, 3)) {
      if (line === '') continue
      const row = JSON.parse(line) as RecordRow
      const fields = Object.keys(row.fields).sort()
      console.log(`  ${row.record_id}: [${fields.map((f) => `'${f}'`).join(', ')}]`)
    }
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
