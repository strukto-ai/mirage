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
import { GDriveResource, MountMode, Workspace, type FileStat, type GDriveConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): GDriveConfig {
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
  const resource = new GDriveResource(buildConfig())
  const ws = new Workspace({ '/gdrive': resource }, { mode: MountMode.WRITE })
  try {
    const root = await run(ws, 'ls /gdrive/')
    printOut('ls /gdrive/', root.out, root.err)

    const entries = root.out.trim().split('\n').filter((s) => s !== '')
    if (entries.length === 0) {
      console.log('No files in /gdrive/')
      return
    }
    const first = entries[0]!

    const stat = await run(ws, `stat "/gdrive/${first}"`)
    console.log(`=== stat /gdrive/${first} ===`)
    console.log(`  ${stat.out.trim()}`)


    // chmod/chown/touch never hit the Drive API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /gdrive/${first} ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/gdrive/${first}" && chown 500:dev "/gdrive/${first}" && touch -t 202601021530 "/gdrive/${first}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/gdrive/${first}`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    if (first.endsWith('/')) {
      const subLs = await run(ws, `ls "/gdrive/${first}"`)
      printOut(`ls /gdrive/${first}`, subLs.out, subLs.err)
      const subEntries = subLs.out.trim().split('\n').filter((s) => s !== '')
      const sub = subEntries[0]
      if (sub !== undefined && !sub.endsWith('/')) {
        const cat = await run(ws, `cat "/gdrive/${first}${sub}"`)
        printOut(`cat /gdrive/${first}${sub}`, cat.out, cat.err)
      }
    }

    const tree = await run(ws, 'tree -L 1 /gdrive/')
    printOut('tree -L 1 /gdrive/', tree.out, tree.err, 800)

    console.log('\n=== find /gdrive/ -name \'*.gdoc.json\' | head -n 5 ===')
    const findDocs = await run(ws, "find /gdrive/ -name '*.gdoc.json' | head -n 5")
    console.log(findDocs.out.trim())

    const docFiles = findDocs.out.trim().split('\n').filter((s) => s !== '')
    const firstDoc = docFiles[0]
    if (firstDoc !== undefined && firstDoc !== '') {
      const jq = await run(ws, `cat "${firstDoc}" | jq ".title"`)
      printOut(`cat ${firstDoc} | jq .title`, jq.out, jq.err)

      const head = await run(ws, `head -n 3 "${firstDoc}"`)
      printOut(`head -n 3 ${firstDoc}`, head.out, head.err)

      const wc = await run(ws, `wc "${firstDoc}"`)
      printOut(`wc ${firstDoc}`, wc.out, wc.err)

      const basename = await run(ws, `basename "${firstDoc}"`)
      printOut(`basename ${firstDoc}`, basename.out, basename.err)

      const dirname = await run(ws, `dirname "${firstDoc}"`)
      printOut(`dirname ${firstDoc}`, dirname.out, dirname.err)

      const tail = await run(ws, `tail -n 3 "${firstDoc}"`)
      printOut(`tail -n 3 ${firstDoc}`, tail.out, tail.err)

      const nl = await run(ws, `nl "${firstDoc}"`)
      printOut(`nl ${firstDoc}`, nl.out, nl.err, 300)

      const grep = await run(ws, `grep title "${firstDoc}"`)
      printOut(`grep title ${firstDoc}`, grep.out, grep.err, 300)

      const rg = await run(ws, `rg title "${firstDoc}"`)
      printOut(`rg title ${firstDoc}`, rg.out, rg.err, 300)

      const cut = await run(ws, `cut -c 1-40 "${firstDoc}"`)
      printOut(`cut -c 1-40 ${firstDoc}`, cut.out, cut.err, 300)

      const sedPrint = await run(ws, `sed -n 2p "${firstDoc}"`)
      printOut(`sed -n 2p ${firstDoc}`, sedPrint.out, sedPrint.err, 300)

      const sedSub = await run(ws, `sed "s/title/TITLE/g" "${firstDoc}"`)
      printOut(`sed s/title/TITLE/g ${firstDoc}`, sedSub.out, sedSub.err, 300)

      const realpath = await run(ws, `realpath "${firstDoc}"`)
      printOut(`realpath ${firstDoc}`, realpath.out, realpath.err)
    }

    console.log('\n=== gws docs documents create ===')
    const create = await run(
      ws,
      "gws docs documents create --json '{\"title\": \"Test from MIRAGE gdrive\"}'",
    )
    printOut('gws docs documents create', create.out, create.err, 300)

    console.log('\n=== gws sheets spreadsheets create ===')
    const createSheet = await run(
      ws,
      "gws sheets spreadsheets create --json '{\"properties\": {\"title\": \"Test Sheet from gdrive\"}}'",
    )
    printOut('gws sheets spreadsheets create', createSheet.out, createSheet.err, 300)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
