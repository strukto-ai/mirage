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

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { DiskVFS, Mount, MountBackend, MountMode, Workspace } from '@struktoai/mirage-node'

const REPO_ROOT = new URL('../../../..', import.meta.url).pathname
const DATA_DIR = join(REPO_ROOT, 'data')

const tmp = mkdtempSync(join(tmpdir(), 'mirage-disk-fuse-'))
const filesDir = join(tmp, 'files')
cpSync(DATA_DIR, filesDir, { recursive: true })

async function main(): Promise<void> {
  const vfs = new DiskVFS({ root: filesDir })
  const ws = new Workspace({
    '/data/': new Mount(vfs, { mode: MountMode.READ, backend: MountBackend.FUSE }),
  })
  await ws.fuseReady()
  const mp = ws.fuseMountpoint as string
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`)

    const dataPath = mp

    // Async fs only: this process serves the mount, so a sync call on
    // the mountpoint would block the event loop that answers it.
    console.log('--- fs.promises.readdir() ---')
    for (const e of await readdir(dataPath)) {
      const st = await stat(`${dataPath}/${e}`)
      console.log(`  ${e.padEnd(30)} ${st.size.toLocaleString('en-US').padStart(10)} bytes`)
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`)
    console.log('>>> Open another terminal and try:')
    console.log(`>>>   ls -la ${mp}/`)
    console.log(`>>>   cat ${mp}/example.json`)
    console.log(`>>>   cat ${mp}/example.json | jq .`)
    console.log('>>> Press Enter to unmount and exit...')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('')
    rl.close()

    const total = ws.records.reduce((acc, r) => acc + r.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    await ws.close()
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
