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

import dotenv from 'dotenv'
import { MountMode, PostgresVFS, Workspace } from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function requireDsn(): string {
  const value = process.env.POSTGRES_DSN
  if (value === undefined) {
    console.error('POSTGRES_DSN missing in .env.development')
    process.exit(1)
  }
  return value
}

const dsn = requireDsn()

const DEC = new TextDecoder()

async function dump(ws: Workspace, label: string, cmd: string): Promise<void> {
  console.log(`\n--- ${label} ---`)
  const r = await ws.shell(cmd)
  if (r.exitCode !== 0) {
    console.log(`(exit=${String(r.exitCode)}) ${DEC.decode(r.stderr)}`)
    return
  }
  process.stdout.write(DEC.decode(r.stdout))
  if (!DEC.decode(r.stdout).endsWith('\n')) process.stdout.write('\n')
}

async function main(): Promise<void> {
  const vfs = new PostgresVFS({
    dsn,
    maxReadRows: 200,
    maxReadBytes: 1024 * 1024,
  })
  const ws = new Workspace({ '/pg/': vfs }, { mode: MountMode.READ })

  try {
    console.log('=== VFS MODE: shell pipelines transparently read Postgres ===')

    await dump(ws, 'ls /pg — root entries', 'ls /pg')
    await dump(ws, 'ls /pg/public', 'ls /pg/public')
    await dump(ws, 'ls /pg/public/tables (first 5)', 'ls /pg/public/tables | head -n 5')

    const tablesOut = await ws.shell('ls /pg/public/tables')
    const tables = DEC.decode(tablesOut.stdout).split('\n').filter((s) => s.length > 0)
    if (tables.length === 0) {
      console.log('\nno tables in public; stopping')
      return
    }

    const target = tables[0]!
    const dir = `/pg/public/tables/${target}`

    await dump(ws, `ls ${dir}`, `ls ${dir}`)
    await dump(ws, 'cat database.json | jq .schemas', 'cat /pg/database.json | jq ".schemas"')
    await dump(ws, `jq .name ${dir}/schema.json`, `jq ".name" ${dir}/schema.json`)
    await dump(ws, `head -n 1 ${dir}/rows.jsonl`, `head -n 1 ${dir}/rows.jsonl`)
    await dump(ws, `wc -l ${dir}/rows.jsonl`, `wc -l ${dir}/rows.jsonl`)
    await dump(
      ws,
      `cat ${dir}/rows.jsonl (size guard fires for large tables)`,
      `cat ${dir}/rows.jsonl | wc -l`,
    )
    await dump(
      ws,
      `grep -c context ${dir}/rows.jsonl`,
      `grep -c context ${dir}/rows.jsonl`,
    )
  } finally {
    await ws.close()
    await vfs.close()
  }
}

await main()
