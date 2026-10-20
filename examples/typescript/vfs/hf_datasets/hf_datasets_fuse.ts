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

import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  HfDatasetsVFS,
  Mount,
  MountBackend,
  MountMode,
  Workspace,
  type HfDatasetsConfig,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function configFromEnv(): HfDatasetsConfig {
  return {
    repoId: process.env.HF_DATASET_REPO ?? 'AlienKevin/SWE-ZERO-12M-trajectories',
    ...(process.env.HF_TOKEN !== undefined ? { token: process.env.HF_TOKEN } : {}),
  }
}

async function main(): Promise<void> {
  const vfs = new HfDatasetsVFS(configFromEnv())
  const ws = new Workspace({
    '/ds/': new Mount(vfs, { mode: MountMode.READ, backend: MountBackend.FUSE }),
  })
  await ws.fuseReady()
  const mp = ws.fuseMountpoint as string
  try {
    console.log(`=== FUSE: mounted at ${mp} ===\n`)

    // Async fs only: this process serves the mount, so a sync call on
    // the mountpoint would block the event loop that answers it.
    console.log(`--- readdir(${mp}) ---`)
    const rootEntries = await readdir(mp)
    for (const e of rootEntries) console.log(`  ${e}`)

    const target = `${mp}/README.md`
    if (rootEntries.includes('README.md')) {
      console.log(`\n--- read first 5 lines of ${target} ---`)
      const lines = (await readFile(target, 'utf-8')).split('\n')
      for (const [i, line] of lines.slice(0, 5).entries()) {
        console.log(`  [${String(i)}] ${line.trimEnd().slice(0, 100)}`)
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`)
    console.log('>>> In another terminal:')
    console.log(`>>>   ls ${mp}/`)
    console.log(`>>>   find ${mp}/ -name '*.parquet' | head`)
    console.log('>>> Press Enter to unmount...')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('')
    rl.close()

    const total = ws.records.reduce((acc, r) => acc + r.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
