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

import { readdirSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { FuseManager, MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'

const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url))

async function main(): Promise<void> {
  const resource = new RAMResource()

  // Seed via a temporary WRITE-mode workspace, then mount the same resource READ-only.
  const seedWs = new Workspace({ '/data/': resource }, { mode: MountMode.WRITE })
  const seedEntries = readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const e of seedEntries) {
    const raw = readFileSync(join(DATA_DIR, e.name))
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    await seedWs.fs.writeFile('/data/' + e.name, bytes)
  }
  await seedWs.close()

  console.log(`Seeded ${String(resource.store.files.size)} files from ${DATA_DIR}`)

  const ws = new Workspace({ '/data/': resource }, { mode: MountMode.READ })
  const fm = new FuseManager()
  const mp = await fm.setup(ws)
  let cleaned = false
  const handler = (sig: NodeJS.Signals): void => {
    if (cleaned) return
    cleaned = true
    void (async (): Promise<void> => {
      try { await fm.close() } catch {}
      try { await ws.close() } catch {}
      console.error(`\n>>> unmounted ${mp}`)
      process.exit(sig === 'SIGINT' ? 130 : 143)
    })()
  }
  process.on('SIGINT', handler)
  process.on('SIGTERM', handler)
  try {
    console.log(`\n=== FUSE MODE (READ): mounted at ${mp} ===\n`)

    const dataPath = `${mp}/data`
    const list = (await readdir(dataPath)).sort()
    for (const name of list) {
      const st = await stat(`${dataPath}/${name}`)
      console.log(`  ${name.padEnd(30)} ${st.size.toLocaleString('en-US').padStart(10)} bytes`)
    }

    const existing = list[0] ?? 'example.json'
    console.log(`\n>>> FUSE mounted READ-ONLY at: ${mp}`)
    console.log('>>> In another terminal: reads should succeed, writes should fail with EACCES.')
    console.log(`>>>   cat ${dataPath}/${existing}                 # ok`)
    console.log(`>>>   echo hi > ${dataPath}/new.txt               # EACCES (create)`)
    console.log(`>>>   echo hi > ${dataPath}/${existing}           # EACCES (overwrite; the bug PR #104 fixed)`)
    console.log('>>> Press Enter to unmount and exit...')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('')
    rl.close()
  } finally {
    await fm.close()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
