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
import { MountMode, PostgresVFS, Workspace, type FileStat } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

const dsn = process.env.POSTGRES_DSN
if (dsn === undefined) {
  console.error('POSTGRES_DSN missing in .env.development')
  process.exit(1)
}

const vfs = new PostgresVFS({ dsn })
const ws = new Workspace({ '/pg/': vfs }, { mode: MountMode.READ })

const DEC = new TextDecoder()

// Python's shlex.quote, so the printed commands match the Python example.
function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function run(label: string, cmd: string): Promise<void> {
  console.log(`\n=== ${label} ===`)
  const r = await ws.shell(cmd)
  if (r.exitCode !== 0) {
    console.log(`(exit=${String(r.exitCode)})`)
    if (r.stderr.byteLength > 0) console.log(DEC.decode(r.stderr))
    if (r.stdout.byteLength > 0) console.log(DEC.decode(r.stdout))
    return
  }
  process.stdout.write(DEC.decode(r.stdout))
  if (!DEC.decode(r.stdout).endsWith('\n')) process.stdout.write('\n')
}

try {
  await run('ls /pg', 'ls /pg')

  await run('cat /pg/database.json (head)', 'head -n 20 /pg/database.json')

  const dirOut = await ws.shell('ls /pg/public/tables')
  const tables = DEC.decode(dirOut.stdout)
    .split('\n')
    .filter((s) => s.length > 0)
  if (tables.length === 0) {
    console.log('\nno tables in public schema; stopping')
  } else {
    const target = tables[0]!
    const dir = `/pg/public/tables/${target}`

    await run(`ls ${dir}`, `ls ${shellQuote(dir)}`)
    await run('stat schema.json', `stat ${shellQuote(`${dir}/schema.json`)}`)
    await run('stat rows.jsonl', `stat ${shellQuote(`${dir}/rows.jsonl`)}`)

    // chmod/chown/touch never hit Postgres: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${dir}/rows.jsonl ===`)
    const metaRes = await ws.shell(
      `chmod 640 ${shellQuote(`${dir}/rows.jsonl`)} && chown 500:dev ${shellQuote(`${dir}/rows.jsonl`)} && touch -t 202601021530 ${shellQuote(`${dir}/rows.jsonl`)}`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    try {
      const metaSt = (await ws.dispatch('stat', `${dir}/rows.jsonl`)) as FileStat
      const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
      console.log(
        `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      console.log('  dispatch stat: target missing in this environment')
    }
    await run('cat schema.json', `cat ${shellQuote(`${dir}/schema.json`)}`)
    await run('head -n 3 rows.jsonl', `head -n 3 ${shellQuote(`${dir}/rows.jsonl`)}`)
    await run('tail -n 2 rows.jsonl', `tail -n 2 ${shellQuote(`${dir}/rows.jsonl`)}`)
    await run('wc -l rows.jsonl', `wc -l ${shellQuote(`${dir}/rows.jsonl`)}`)
    await run('grep -c ":" rows.jsonl', `grep -c ":" ${shellQuote(`${dir}/rows.jsonl`)}`)
    await run('jq .name schema.json', `jq ".name" ${shellQuote(`${dir}/schema.json`)}`)
    await run('find /pg/public -maxdepth 2', 'find /pg/public -maxdepth 2')
    await run('tree -L 2 /pg/public', 'tree -L 2 /pg/public')

    await run(
      'cat rows.jsonl (size guard fires for huge tables)',
      `cat ${shellQuote(`${dir}/rows.jsonl`)} | wc -l`,
    )
  }

  console.log('\n=== ops summary ===')
  // workspace exposes ops counts via internal observer; we just confirm we got here cleanly.
  console.log('all commands completed')
} finally {
  await ws.close()
  await vfs.close()
}
