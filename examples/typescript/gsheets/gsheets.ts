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
import { GSheetsResource, MountMode, Workspace, type FileStat, type GSheetsConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): GSheetsConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

async function run(ws: Workspace, cmd: string): Promise<{ out: string; err: string; code: number }> {
  try {
    const r = await ws.execute(cmd)
    return { out: r.stdoutText, err: r.stderrText, code: r.exitCode }
  } catch (err) {
    return { out: '', err: err instanceof Error ? err.message : String(err), code: 1 }
  }
}

function printOut(label: string, out: string, err: string, max = 500): void {
  console.log(`=== ${label} ===`)
  if (out !== '') console.log(out.length > max ? out.slice(0, max) + '...' : out)
  if (err !== '') process.stderr.write(`  STDERR: ${err.trim().slice(0, 200)}\n`)
}

async function main(): Promise<void> {
  const resource = new GSheetsResource(buildConfig())
  const ws = new Workspace({ '/gsheets': resource }, { mode: MountMode.WRITE })
  try {
    const root = await run(ws, 'ls /gsheets/')
    printOut('ls /gsheets/', root.out, root.err)

    const ownedHead = await run(ws, 'ls /gsheets/owned/ | head -n 5')
    printOut('ls /gsheets/owned/ (first 5)', ownedHead.out, ownedHead.err)
    const first = ownedHead.out.trim().split('\n')[0]
    if (first === undefined || first === '') {
      console.log('no sheets in /gsheets/owned/')
      return
    }

    const cat = await run(ws, `cat "/gsheets/owned/${first}"`)
    printOut('cat (first 300)', cat.out, cat.err, 300)

    const stat = await run(ws, `stat "/gsheets/owned/${first}"`)
    console.log('=== stat ===')
    console.log(`  ${stat.out.trim()}`)


    // chmod/chown/touch never hit the Sheets API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /gsheets/owned/${first} ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/gsheets/owned/${first}" && chown 500:dev "/gsheets/owned/${first}" && touch -t 202601021530 "/gsheets/owned/${first}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/gsheets/owned/${first}`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    const jq = await run(ws, `jq ".properties.title" "/gsheets/owned/${first}"`)
    console.log('=== jq .properties.title ===')
    console.log(`  ${jq.out.trim()}`)

    const tree = await run(ws, 'tree /gsheets/')
    printOut('tree /gsheets/', tree.out, tree.err, 500)

    const findOwned = await run(ws, "find /gsheets/owned/ -name '*.gsheet.json' | head -n 5")
    printOut('find /gsheets/owned/', findOwned.out, findOwned.err, 2000)

    console.log('\n=== gws-sheets-spreadsheets-create ===')
    const create = await run(
      ws,
      "gws-sheets-spreadsheets-create --json '{\"properties\": {\"title\": \"MIRAGE TS Example Sheet\"}}'",
    )
    if (create.code !== 0) {
      printOut('create FAILED', create.out, create.err)
      return
    }
    const sheet = JSON.parse(create.out) as { spreadsheetId?: string }
    const sheetId = sheet.spreadsheetId
    if (sheetId === undefined || sheetId === '') {
      console.log('  no spreadsheetId returned')
      return
    }
    console.log(`Created: ${sheetId}`)

    console.log('\n=== gws-sheets-write (A1:B2) ===')
    const writeParams = JSON.stringify({ spreadsheetId: sheetId, range: 'A1:B2' })
    const writeBody = JSON.stringify({
      values: [
        ['hello', 'world'],
        ['foo', 'bar'],
      ],
    })
    const write = await run(
      ws,
      `gws-sheets-write --params '${writeParams}' --json '${writeBody}'`,
    )
    console.log(`Written: ${write.out.slice(0, 80)}`)

    console.log('\n=== gws-sheets-append (A:B) ===')
    const append = await run(
      ws,
      `gws-sheets-append --spreadsheet ${sheetId} --range "A:B" --json-values '[["appended", "row"]]'`,
    )
    console.log(`Appended: ${append.out.slice(0, 80)}`)

    console.log('\n=== gws-sheets-read (A1:B3) ===')
    const read = await run(ws, `gws-sheets-read --spreadsheet ${sheetId} --range "A1:B3"`)
    console.log(read.out.trim())

    console.log(`\nOpen: https://docs.google.com/spreadsheets/d/${sheetId}/edit`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
