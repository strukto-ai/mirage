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

import { QdrantClient } from '@qdrant/js-client-rest'
import { MountMode, QdrantVFS, Workspace, type FileStat } from '@struktoai/mirage-node'
import { buildCollection, buildLineageCollection, embed } from './build_collection.ts'

function client(): QdrantClient {
  const url = process.env.QDRANT_URL
  if (url !== undefined) return new QdrantClient({ url, apiKey: process.env.QDRANT_API_KEY })
  return new QdrantClient({
    host: process.env.QDRANT_HOST ?? 'localhost',
    port: Number(process.env.QDRANT_PORT ?? '6333'),
  })
}

const DEC = new TextDecoder()

async function show(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n=== ${cmd} ===`)
  const r = await ws.shell(cmd)
  console.log(DEC.decode(r.stdout).trimEnd())
}

async function main(): Promise<void> {
  const qc = client()
  await buildCollection(qc, 'fashion')
  await buildLineageCollection(qc, 'company_docs')

  const connection = {
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
    host: process.env.QDRANT_HOST ?? 'localhost',
    port: Number(process.env.QDRANT_PORT ?? '6333'),
    // `search` vectorizes its query through this hook, in-process, so a
    // self-hosted Qdrant with no inference works and mirage itself
    // depends on no model runtime.
    embed: (text: string): Promise<number[]> => Promise.resolve(embed(text)),
  }
  const fashion = new QdrantVFS({
    config: {
      ...connection,
      collection: 'fashion',
      groupBy: ['gender', 'articleType', 'baseColour'],
      idField: 'id',
      textField: 'productDisplayName',
      blobField: 'image_b64',
      blobExt: 'jpg',
      searchLimit: 4,
    },
  })
  // Chunks grouped by the document they came from: `metadata.source` is
  // a nested payload path, `basenameFields` lists it by file name, and
  // `nameField` puts the page label in front of the point id.
  const docs = new QdrantVFS({
    config: {
      ...connection,
      collection: 'company_docs',
      groupBy: ['metadata.source'],
      basenameFields: ['metadata.source'],
      nameField: 'metadata.page',
      textField: 'page_content',
      searchLimit: 2,
    },
  })
  const ws = new Workspace({ '/fashion/': fashion, '/docs/': docs }, { mode: MountMode.READ })

  console.log("=== mounted Qdrant collection 'fashion' at /fashion/ ===")

  await show(ws, 'ls /fashion/')
  await show(ws, 'tree -L 2 /fashion/')
  await show(ws, 'ls /fashion/Men/Shoes/White')
  await show(ws, 'cat /fashion/Men/Shoes/White/3.txt')
  await show(ws, 'cat /fashion/Men/Shoes/White/3.json')

  console.log('\n=== stat /fashion/Men/Shoes/White/3.jpg (raw image bytes) ===')
  const s = await ws.shell("stat -c '%s' /fashion/Men/Shoes/White/3.jpg")
  console.log(`  image size: ${DEC.decode(s.stdout).trim()} bytes`)

  // chmod/chown/touch never hit the Qdrant API: attrs land in the
  // workspace namespace (durable, snapshot-captured) and merge into
  // dispatch-level stat.
  console.log('=== metadata overlay on /fashion/Men/Shoes/White/3.json ===')
  const metaRes = await ws.shell(
    'chmod 640 "/fashion/Men/Shoes/White/3.json"' +
      ' && chown 500:dev "/fashion/Men/Shoes/White/3.json"' +
      ' && touch -t 202601021530 "/fashion/Men/Shoes/White/3.json"',
  )
  console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
  const metaSt = (await ws.dispatch('stat', '/fashion/Men/Shoes/White/3.json')) as FileStat
  const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
  console.log(
    `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
  )

  await show(ws, 'search "white running sneakers" /fashion')

  await show(ws, 'grep -ril blue /fashion/Women')
  await show(ws, 'rg -li running /fashion/Men')

  console.log("\n=== find /fashion -name '*.txt' | wc -l ===")
  const f = await ws.shell("find /fashion -name '*.txt' | wc -l")
  console.log(`  products: ${DEC.decode(f.stdout).trim()}`)

  console.log("\n=== mounted Qdrant collection 'company_docs' at /docs/ ===")
  // One directory per source document, named by its basename; each
  // chunk is `<page>__<point-id>.txt` beside its `.json` payload.
  await show(ws, 'tree /docs/')
  await show(ws, 'cat /docs/refund-2026.pdf/004__102.txt')
  await show(ws, 'cat /docs/refund-2026.pdf/004__102.json')
  await show(ws, 'search "how long does a refund take" /docs')

  await fashion.close()
  await docs.close()
}

void main()
