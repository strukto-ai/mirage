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
import { GSlidesResource, MountMode, Workspace, type FileStat, type GSlidesConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): GSlidesConfig {
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
  const resource = new GSlidesResource(buildConfig())
  const ws = new Workspace({ '/gslides': resource }, { mode: MountMode.WRITE })
  try {
    const root = await run(ws, 'ls /gslides/')
    printOut('ls /gslides/', root.out, root.err)

    const ownedHead = await run(ws, 'ls /gslides/owned/ | head -n 5')
    printOut('ls /gslides/owned/ (first 5)', ownedHead.out, ownedHead.err)
    const first = ownedHead.out.trim().split('\n')[0]
    if (first === undefined || first === '') {
      console.log('no decks in /gslides/owned/')
      return
    }

    const cat = await run(ws, `cat "/gslides/owned/${first}"`)
    printOut('cat (first 300)', cat.out, cat.err, 300)

    const stat = await run(ws, `stat "/gslides/owned/${first}"`)
    console.log('=== stat ===')
    console.log(`  ${stat.out.trim()}`)


    // chmod/chown/touch never hit the Slides API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /gslides/owned/${first} ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/gslides/owned/${first}" && chown 500:dev "/gslides/owned/${first}" && touch -t 202601021530 "/gslides/owned/${first}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/gslides/owned/${first}`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    const jq = await run(ws, `jq ".title" "/gslides/owned/${first}"`)
    console.log('=== jq .title ===')
    console.log(`  ${jq.out.trim()}`)

    const tree = await run(ws, 'tree /gslides/')
    printOut('tree /gslides/', tree.out, tree.err, 500)

    const findOwned = await run(ws, "find /gslides/owned/ -name '*.gslide.json' | head -n 5")
    printOut('find /gslides/owned/', findOwned.out, findOwned.err, 2000)

    console.log('\n=== gws slides presentations create ===')
    const create = await run(
      ws,
      "gws slides presentations create --json '{\"title\": \"MIRAGE TS Example Deck\"}'",
    )
    if (create.code !== 0) {
      printOut('create FAILED', create.out, create.err)
      return
    }
    const deck = JSON.parse(create.out) as { presentationId?: string; slides?: { objectId?: string }[] }
    const presId = deck.presentationId
    if (presId === undefined || presId === '') {
      console.log('  no presentationId returned')
      return
    }
    console.log(`Created: ${presId}`)

    console.log('\n=== gws slides presentations batchUpdate (insert text on first slide) ===')
    const slideId = deck.slides?.[0]?.objectId ?? ''
    if (slideId !== '') {
      const params = JSON.stringify({ presentationId: presId })
      const body = JSON.stringify({
        requests: [
          {
            createShape: {
              objectId: 'mirage_textbox',
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId: slideId,
                size: {
                  height: { magnitude: 50, unit: 'PT' },
                  width: { magnitude: 300, unit: 'PT' },
                },
                transform: {
                  scaleX: 1,
                  scaleY: 1,
                  translateX: 100,
                  translateY: 100,
                  unit: 'PT',
                },
              },
            },
          },
          {
            insertText: {
              objectId: 'mirage_textbox',
              text: 'Hello from MIRAGE TS!',
            },
          },
        ],
      })
      const batch = await run(
        ws,
        `gws slides presentations batchUpdate --params '${params}' --json '${body}'`,
      )
      console.log(`Updated: ${batch.out.slice(0, 80)}`)
    }

    console.log(`\nOpen: https://docs.google.com/presentation/d/${presId}/edit`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
