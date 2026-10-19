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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { AirtableVFS, MountMode, Workspace, type AirtableConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function buildConfig(): AirtableConfig {
  const token = process.env.AIRTABLE_TOKEN
  if (token === undefined || token === '') {
    throw new Error('AIRTABLE_TOKEN env var is required')
  }
  return { token }
}

async function run(ws: Workspace, cmd: string): Promise<string> {
  console.log(`$ ${cmd}`)
  const r = await ws.shell(cmd)
  if (r.exitCode !== 0) {
    console.log(`  exit=${String(r.exitCode)}  ${r.stderrText.trim().slice(0, 200)}`)
  }
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') {
    for (const line of out.split('\n').slice(0, 10)) console.log(`  ${line.slice(0, 200)}`)
  }
  return out
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/airtable': new AirtableVFS(buildConfig()) }, { mode: MountMode.READ })
  try {
    const bases = (await run(ws, 'ls /airtable/bases')).split('\n').filter((b) => b !== '')
    const first = bases[0]
    if (first === undefined) {
      console.log('No bases visible to this token')
      return
    }
    const base = `/airtable/bases/${first}`
    await run(ws, `cat ${base}/base.json`)
    const tables = (await run(ws, `ls ${base}`))
      .split('\n')
      .filter((name) => name !== '' && name !== 'base.json')
    const firstTable = tables[0]
    if (firstTable === undefined) return
    const table = `${base}/${firstTable}`
    await run(ws, `jq -r '.fields[] | .field_name + ": " + .type' ${table}/table.json`)
    // head pushes its count into maxRecords: one request, not the table
    await run(ws, `head -n 3 ${table}/records.jsonl | jq -c .fields`)
    await run(ws, `ls ${table}/views`)
    await run(ws, 'cat /airtable/bases/Missing__appMissing00000001/base.json')
  } finally {
    await ws.close()
  }
}

await main()
