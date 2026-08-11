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

import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { NTN } from '@struktoai/mirage-core'
import { MountMode, NotionResource, Workspace, type FileStat, type NotionConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): NotionConfig {
  const apiKey = process.env.NOTION_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error('NOTION_API_KEY env var is required')
  }
  return { apiKey }
}

async function run(ws: Workspace, cmd: string, limit = 1500): Promise<string> {
  console.log(`=== ${cmd} ===`)
  const r = await ws.execute(cmd)
  const out = r.stdoutText.replace(/\s+$/, '')
  console.log(out !== '' ? out.slice(0, limit) : '(empty)')
  if (r.stderrText.trim() !== '') console.log(`  [stderr] ${r.stderrText.trim().slice(0, 300)}`)
  console.log(`  [exit=${String(r.exitCode)}]\n`)
  return out
}

async function firstEntry(ws: Workspace, path: string): Promise<string> {
  const out = (await ws.execute(`ls ${path}`)).stdoutText.trim()
  if (out === '') return ''
  return basename(out.split('\n')[0]!.replace(/\/$/, ''))
}

async function pickChild(ws: Workspace, path: string, skip: string): Promise<string> {
  const listing = (await ws.execute(`ls "${path}/"`)).stdoutText.trim().split('\n')
  for (const line of listing) {
    const name = basename(line.replace(/\/$/, ''))
    if (name !== skip && name !== '') return name
  }
  return ''
}

async function explorePages(ws: Workspace): Promise<void> {
  console.log('\n########## PAGES ##########\n')
  await run(ws, 'ls /notion/pages/')
  const page = await firstEntry(ws, '/notion/pages/')
  if (page === '') {
    console.log('No shared pages available\n')
    return
  }
  const base = `/notion/pages/${page}`
  await run(ws, `ls "${base}/"`)
  await run(ws, `cat "${base}/page.json"`, 1200)
  await run(ws, `head -n 5 "${base}/page.json"`)
  await run(ws, `tail -n 5 "${base}/page.json"`)
  await run(ws, `wc -l "${base}/page.json"`)
  await run(ws, `stat "${base}/page.json"`)


  // chmod/chown/touch never hit the Notion API: attrs land in the
  // workspace namespace (durable, snapshot-captured) and merge into
  // dispatch-level stat.
  console.log(`=== metadata overlay on ${base}/page.json ===`)
  const metaRes = await ws.execute(
    `chmod 640 "${base}/page.json" && chown 500:dev "${base}/page.json" && touch -t 202601021530 "${base}/page.json"`,
  )
  console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
  const metaSt = (await ws.dispatch('stat', `${base}/page.json`)) as FileStat
  const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
  console.log(
    `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
  )
  await run(ws, `jq ".title" "${base}/page.json"`)
  await run(ws, `jq ".page_id" "${base}/page.json"`)
  await run(ws, `jq ".parent_type" "${base}/page.json"`)
  await run(ws, `basename "${base}/page.json"`)
  await run(ws, `dirname "${base}/page.json"`)
  await run(ws, `realpath "${base}/page.json"`)
  await run(ws, `tree -L 1 "${base}/"`)
  await run(ws, `find "${base}/" -name "*.json"`)
  await run(ws, `echo "${base}/"*.json`)
}

async function exploreDatabases(ws: Workspace): Promise<void> {
  console.log('\n########## DATABASES ##########\n')
  await run(ws, 'ls /notion/databases/')
  const db = await firstEntry(ws, '/notion/databases/')
  if (db === '') {
    console.log('No shared databases available\n')
    return
  }
  const base = `/notion/databases/${db}`
  await run(ws, `ls "${base}/"`)
  await run(ws, `stat "${base}/"`)
  await run(ws, `stat "${base}/database.json"`)
  await run(ws, `cat "${base}/database.json"`)
  await run(ws, `jq ".database_id" "${base}/database.json"`)
  await run(ws, `jq ".title" "${base}/database.json"`)
  // The container carries data source stubs, not a column schema: since
  // 2025-09-03 `properties` lives on the data source one level down.
  await run(ws, `jq ".data_sources" "${base}/database.json"`)
  await run(ws, `wc -l "${base}/database.json"`)
  await run(ws, `head -n 8 "${base}/database.json"`)
  await run(ws, `tail -n 5 "${base}/database.json"`)
  await run(ws, `basename "${base}/database.json"`)
  await run(ws, `dirname "${base}/database.json"`)
  await run(ws, `tree -L 2 "${base}/"`)
  await run(ws, `find "${base}/" -name "database.json"`)
  await run(ws, `echo "${base}/"*`)

  const source = await pickChild(ws, base, 'database.json')
  if (source === '') {
    console.log('Database has no data sources\n')
    return
  }
  const sourceBase = `${base}/${source}`
  console.log(`--- data source: ${source} ---\n`)
  await run(ws, `ls "${sourceBase}/"`)
  await run(ws, `cat "${sourceBase}/data_source.json"`)
  await run(ws, `jq ".properties | keys" "${sourceBase}/data_source.json"`)

  const row = await pickChild(ws, sourceBase, 'data_source.json')
  if (row === '') {
    console.log('Data source has no row pages\n')
    return
  }
  const rowBase = `${sourceBase}/${row}`
  console.log(`--- row page: ${row} ---\n`)
  await run(ws, `ls "${rowBase}/"`)
  await run(ws, `stat "${rowBase}/page.json"`)
  await run(ws, `cat "${rowBase}/page.json"`, 1200)
  await run(ws, `jq ".parent_type" "${rowBase}/page.json"`)
  await run(ws, `jq ".parent_id" "${rowBase}/page.json"`)
  // A row's cells ride in the file, as Notion's own property objects,
  // answering to the schema in the data_source.json above.
  await run(ws, `jq ".properties | keys" "${rowBase}/page.json"`)
}

async function exploreCrossCutting(ws: Workspace): Promise<void> {
  console.log('\n########## CROSS-CUTTING ##########\n')
  await run(ws, 'ls /notion/')
  await run(ws, 'tree -L 2 /notion/')
  // There is no `ntn search`: /search is reached through `ntn api`,
  // exactly as the official CLI reaches it.
  await run(ws, `ntn api v1/search -d '{"query":"a"}'`, 800)
  await run(ws, 'grep -rl "page_id" /notion/pages/', 800)
  await run(ws, 'rg -c "title" /notion/databases/', 800)
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/notion': new NotionResource(buildConfig()) },
    { mode: MountMode.READ },
  )
  ws.registerCli('ntn', NTN, buildConfig() as unknown as Record<string, unknown>)
  try {
    await explorePages(ws)
    await exploreDatabases(ws)
    await exploreCrossCutting(ws)
    const records = ws.records
    const total = records.reduce((acc, r) => acc + (r.bytes ?? 0), 0)
    console.log(`\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
