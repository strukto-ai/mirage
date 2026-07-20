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
import { GDocsResource, MountMode, Workspace, type FileStat, type GDocsConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): GDocsConfig {
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
  const resource = new GDocsResource(buildConfig())
  const ws = new Workspace({ '/gdocs': resource }, { mode: MountMode.WRITE })
  try {
    const root = await run(ws, 'ls /gdocs/')
    printOut('ls /gdocs/', root.out, root.err)

    const ownedHead = await run(ws, 'ls /gdocs/owned/ | head -n 5')
    printOut('ls /gdocs/owned/ (first 5)', ownedHead.out, ownedHead.err)
    const first = ownedHead.out.trim().split('\n')[0]
    if (first === undefined || first === '') {
      console.log('no docs in /gdocs/owned/')
      return
    }

    const cat = await run(ws, `cat "/gdocs/owned/${first}"`)
    printOut('cat (first 300)', cat.out, cat.err, 300)

    const head = await run(ws, `head -n 20 "/gdocs/owned/${first}"`)
    printOut('head -n 20', head.out, head.err)

    const tail = await run(ws, `tail -n 10 "/gdocs/owned/${first}"`)
    printOut('tail -n 10', tail.out, tail.err)

    const wc = await run(ws, `wc "/gdocs/owned/${first}"`)
    console.log('=== wc ===')
    console.log(`  ${wc.out.trim()}`)

    const stat = await run(ws, `stat "/gdocs/owned/${first}"`)
    console.log('=== stat ===')
    console.log(`  ${stat.out.trim()}`)


    // chmod/chown/touch never hit the Docs API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /gdocs/owned/${first} ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/gdocs/owned/${first}" && chown 500:dev "/gdocs/owned/${first}" && touch -t 202601021530 "/gdocs/owned/${first}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/gdocs/owned/${first}`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    const jq = await run(ws, `jq ".title" "/gdocs/owned/${first}"`)
    console.log('=== jq .title ===')
    console.log(`  ${jq.out.trim()}`)

    const nl = await run(ws, `nl "/gdocs/owned/${first}" | head -n 10`)
    printOut('nl | head -n 10', nl.out, nl.err)

    const tree = await run(ws, 'tree /gdocs/')
    printOut('tree /gdocs/', tree.out, tree.err, 500)

    const find = await run(ws, "find /gdocs/owned/ -name '*.gdoc.json' | head -n 5")
    printOut("find -name '*.gdoc.json' (first 5)", find.out, find.err)

    const grep = await run(ws, `grep textRun "/gdocs/owned/${first}" | head -c 200`)
    printOut('grep textRun (first 200B)', grep.out, grep.err, 200)

    const rg = await run(ws, `rg textRun "/gdocs/owned/${first}" | head -c 200`)
    printOut('rg textRun (first 200B)', rg.out, rg.err, 200)

    const basename = await run(ws, `basename "/gdocs/owned/${first}"`)
    console.log('=== basename ===')
    console.log(`  ${basename.out.trim()}`)

    const dirname = await run(ws, `dirname "/gdocs/owned/${first}"`)
    console.log('=== dirname ===')
    console.log(`  ${dirname.out.trim()}`)

    const realpath = await run(ws, `realpath "/gdocs/owned/${first}"`)
    console.log('=== realpath ===')
    console.log(`  ${realpath.out.trim()}`)

    console.log('\n=== gws docs documents create ===')
    const create = await run(
      ws,
      "gws docs documents create --json '{\"title\": \"MIRAGE TS Example Doc\"}'",
    )
    if (create.code !== 0) {
      printOut('create FAILED', create.out, create.err)
      return
    }
    const doc = JSON.parse(create.out) as { documentId?: string }
    const docId = doc.documentId
    if (docId === undefined || docId === '') {
      console.log('  no documentId returned')
      return
    }
    console.log(`Created: ${docId}`)

    console.log('\n=== gws docs documents batchUpdate ===')
    const body = JSON.stringify({
      requests: [{ insertText: { location: { index: 1 }, text: 'Hello from MIRAGE TS!\n' } }],
    })
    const params = JSON.stringify({ documentId: docId })
    const update = await run(
      ws,
      `gws docs documents batchUpdate --params '${params}' --json '${body}'`,
    )
    console.log(`Updated: ${update.out.slice(0, 80)}`)

    console.log('\n=== gws docs +write ===')
    const write = await run(
      ws,
      `gws docs +write --document ${docId} --text "Appended via gws docs +write."`,
    )
    console.log(`Written: ${write.out.slice(0, 80)}`)

    console.log(`\nOpen: https://docs.google.com/document/d/${docId}/edit`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
