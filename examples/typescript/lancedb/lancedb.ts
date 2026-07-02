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

import { connect } from '@lancedb/lancedb'
import { getRegistry, LanceSchema, TextEmbeddingFunction } from '@lancedb/lancedb/embedding'
import { Binary, Int32, Utf8 } from 'apache-arrow'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LanceDBResource, MountMode, Workspace, type FileStat } from '@struktoai/mirage-node'

const FASHION_VOCAB = [
  'men', 'women', 'tshirt', 'shirt', 'jeans', 'shoes', 'sneakers', 'heels',
  'jacket', 'dress', 'blue', 'red', 'black', 'white', 'green', 'running',
  'casual', 'formal', 'sports', 'summer', 'winter',
]
const INDEX = new Map(FASHION_VOCAB.map((token, i) => [token, i]))

const PRODUCTS: [string, string, string, string][] = [
  ['Men', 'Tshirts', 'Blue', 'Roadster Men Blue Casual Tshirt'],
  ['Men', 'Tshirts', 'Black', 'HRX Men Black Sports Tshirt'],
  ['Men', 'Shoes', 'White', 'Nike Men White Running Sneakers'],
  ['Men', 'Shoes', 'Black', 'Puma Men Black Formal Shoes'],
  ['Men', 'Jeans', 'Blue', 'Levis Men Blue Casual Jeans'],
  ['Women', 'Tshirts', 'Red', 'Roadster Women Red Casual Tshirt'],
  ['Women', 'Shoes', 'Red', 'Steve Madden Women Red Heels'],
  ['Women', 'Shoes', 'White', 'Adidas Women White Running Sneakers'],
  ['Women', 'Dress', 'Black', 'Zara Women Black Formal Dress'],
  ['Women', 'Jeans', 'Blue', 'H&M Women Blue Summer Jeans'],
]

function embed(text: string): number[] {
  const vector = new Array<number>(FASHION_VOCAB.length).fill(0)
  for (const word of text.toLowerCase().split(/\s+/)) {
    const idx = INDEX.get(word.replace(/^[.,]+|[.,]+$/g, ''))
    if (idx !== undefined) vector[idx] = 1
  }
  const magnitude = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0))
  const norm = magnitude === 0 ? 1 : magnitude
  return vector.map((x) => x / norm)
}

class KeywordEmbedding extends TextEmbeddingFunction {
  ndims(): number {
    return FASHION_VOCAB.length
  }
  toJSON(): Record<string, never> {
    return {}
  }
  generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map(embed))
  }
}
getRegistry().register('fashion-keyword')(KeywordEmbedding)

async function buildTable(uri: string): Promise<void> {
  const func = getRegistry().get('fashion-keyword').create() as KeywordEmbedding
  const schema = LanceSchema({
    id: new Int32(),
    gender: new Utf8(),
    articleType: new Utf8(),
    baseColour: new Utf8(),
    productDisplayName: func.sourceField(new Utf8()),
    image_bytes: new Binary(),
    vector: func.vectorField(),
  })
  const enc = new TextEncoder()
  const rows = PRODUCTS.map(([gender, articleType, baseColour, name], i) => ({
    id: i + 1,
    gender,
    articleType,
    baseColour,
    productDisplayName: name,
    image_bytes: new Uint8Array([0xff, 0xd8, 0xff, ...enc.encode(name)]),
  }))
  const db = await connect(uri)
  await db.createTable('fashion', rows, { schema })
}

const DEC = new TextDecoder()

async function show(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n=== ${cmd} ===`)
  const r = await ws.execute(cmd)
  console.log(DEC.decode(r.stdout).trimEnd())
}

async function main(): Promise<void> {
  const uri = mkdtempSync(join(tmpdir(), 'mirage-fashion-'))
  await buildTable(uri)

  const resource = new LanceDBResource({
    config: {
      uri,
      table: 'fashion',
      groupBy: ['gender', 'articleType', 'baseColour'],
      idColumn: 'id',
      titleColumn: 'productDisplayName',
      blobColumn: 'image_bytes',
      blobExt: 'jpg',
      textColumn: 'productDisplayName',
      vectorColumn: 'vector',
      searchLimit: 4,
    },
  })
  const ws = new Workspace({ '/fashion/': resource }, { mode: MountMode.READ })

  console.log(`=== mounted LanceDB table 'fashion' (${uri}) at /fashion/ ===`)

  await show(ws, 'ls /fashion/')
  await show(ws, 'tree -L 2 /fashion/')
  await show(ws, 'ls /fashion/Men/Shoes')
  await show(ws, 'cat /fashion/Men/Shoes/White/3.md')
  await show(ws, 'head -n 3 /fashion/Men/Shoes/White/3.md')
  await show(ws, 'tail -n 2 /fashion/Men/Shoes/White/3.md')

  console.log('\n=== stat /fashion/Men/Shoes/White/3.jpg (raw image bytes) ===')
  const s = await ws.execute("stat -c '%s' /fashion/Men/Shoes/White/3.jpg")
  console.log(`  image size: ${DEC.decode(s.stdout).trim()} bytes`)


  // chmod/chown/touch never hit LanceDB: attrs land in the
  // workspace namespace (durable, snapshot-captured) and merge into
  // dispatch-level stat.
  console.log(`=== metadata overlay on /fashion/Men/Shoes/White/3.md ===`)
  const metaRes = await ws.execute(
    `chmod 640 "/fashion/Men/Shoes/White/3.md" && chown 500:dev "/fashion/Men/Shoes/White/3.md" && touch -t 202601021530 "/fashion/Men/Shoes/White/3.md"`,
  )
  console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
  const metaSt = (await ws.dispatch('stat', `/fashion/Men/Shoes/White/3.md`)) as FileStat
  const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
  console.log(
    `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
  )

  await show(ws, 'search "white running sneakers" /fashion')

  await show(ws, 'grep -ril blue /fashion/Women')
  await show(ws, 'rg -li running /fashion/Men')

  console.log("\n=== find /fashion -name '*.md' | wc -l ===")
  const f = await ws.execute("find /fashion -name '*.md' | wc -l")
  console.log(`  product cards: ${DEC.decode(f.stdout).trim()}`)

  await resource.close()
}

void main()
