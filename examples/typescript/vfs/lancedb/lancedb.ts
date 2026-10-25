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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LanceDBVFS, MountMode, SEARCH, Workspace, type FileStat } from '@struktoai/mirage-node'
import { buildTable } from './build_table.ts'

const DEC = new TextDecoder()

async function show(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n=== ${cmd} ===`)
  const r = await ws.shell(cmd)
  console.log(DEC.decode(r.stdout).trimEnd())
}

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
  ws.registerCli('search', SEARCH)

  console.log(`=== mounted LanceDB table 'fashion' (${uri}) at /fashion/ ===`)

  await show(ws, 'ls /fashion/')
  await show(ws, 'tree -L 2 /fashion/')
  await show(ws, 'ls /fashion/Men/Shoes')
  await show(ws, 'cat /fashion/Men/Shoes/White/3.md')
  await show(ws, 'head -n 3 /fashion/Men/Shoes/White/3.md')
  await show(ws, 'tail -n 2 /fashion/Men/Shoes/White/3.md')

  console.log('\n=== stat /fashion/Men/Shoes/White/3.jpg (raw image bytes) ===')
  const s = await ws.shell("stat -c '%s' /fashion/Men/Shoes/White/3.jpg")
  console.log(`  image size: ${DEC.decode(s.stdout).trim()} bytes`)

  // chmod/chown/touch never hit LanceDB: attrs land in the
  // workspace namespace (durable, snapshot-captured) and merge into
  // dispatch-level stat.
  console.log(`=== metadata overlay on /fashion/Men/Shoes/White/3.md ===`)
  const metaRes = await ws.shell(
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
  const f = await ws.shell("find /fashion -name '*.md' | wc -l")
  console.log(`  product cards: ${DEC.decode(f.stdout).trim()}`)

  await vfs.close()
}

void main()
