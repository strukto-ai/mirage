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

import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LanceDBVFS, MountMode, patchNodeFs, Workspace } from '@struktoai/mirage-node'
import { buildTable } from './build_table.ts'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

async function main(): Promise<void> {
  const uri = mkdtempSync(join(tmpdir(), 'mirage-fashion-'))
  await buildTable(uri, 'fashion')

  const vfs = new LanceDBVFS({
    config: {
      uri,
      table: 'fashion',
      groupBy: ['gender', 'articleType', 'baseColour'],
      idColumn: 'id',
      titleColumn: 'productDisplayName',
      blobColumn: 'image_bytes',
      blobExt: 'jpg',
      vectorColumn: 'vector',
      searchLimit: 4,
    },
  })
  const ws = new Workspace({ '/fashion/': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log(`=== VFS MODE: LanceDB table 'fashion' (${uri}) at /fashion/ ===`)

    console.log('\n--- list /fashion ---')
    for (const entry of await fs.promises.readdir('/fashion')) console.log(`  ${entry}`)

    console.log('\n--- list /fashion/Men/Shoes/White ---')
    for (const entry of await fs.promises.readdir('/fashion/Men/Shoes/White')) {
      console.log(`  ${entry}`)
    }

    console.log('\n--- read /fashion/Men/Shoes/White/3.md ---')
    const card = await fs.promises.readFile('/fashion/Men/Shoes/White/3.md', 'utf-8')
    for (const line of card.trimEnd().split('\n')) console.log(`  ${line}`)

    console.log('\n--- read /fashion/Men/Shoes/White/3.jpg (raw image bytes) ---')
    const image = await fs.promises.readFile('/fashion/Men/Shoes/White/3.jpg')
    console.log(
      `  size: ${String(image.length)} bytes, magic: ${image.subarray(0, 3).toString('hex')}`,
    )

    console.log('\n--- stat ---')
    for (const path of ['/fashion/Men/Shoes', '/fashion/Men/Shoes/White/3.md']) {
      const st = await fs.promises.stat(path)
      console.log(`  ${path}: ${st.isDirectory() ? 'directory' : 'file'}`)
    }

    // Every product is a card under gender/articleType/baseColour.
    console.log('\n--- walk /fashion: product cards ---')
    const cards = (await fs.promises.readdir('/fashion', { recursive: true }))
      .filter((rel) => rel.endsWith('.md'))
      .map((rel) => `/fashion/${rel}`)
      .sort()
    for (const path of cards) console.log(`  ${path}`)
    console.log(`  total: ${String(cards.length)}`)

    console.log('\n--- shell view ---')
    const r = await ws.shell('search "white running sneakers" /fashion')
    for (const line of r.stdoutText.split('\n')) {
      if (line.startsWith('/fashion/')) console.log(`  ${line}`)
    }

    const records = ws.records
    const total = records.reduce((acc, record) => acc + record.bytes, 0)
    console.log(`\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
