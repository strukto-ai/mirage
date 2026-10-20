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

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  HfDatasetsVFS,
  MountMode,
  patchNodeFs,
  Workspace,
  type HfDatasetsConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

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
  const ws = new Workspace({ '/ds/': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log(`=== VFS: ${vfs.accessor.bucketUri} ===`)

    console.log("\n--- fs.readdir('/ds') ---")
    const rootEntries = await fs.promises.readdir('/ds')
    for (const e of rootEntries) console.log(`  ${e}`)

    if (rootEntries.includes('README.md')) {
      console.log('\n--- read first 5 lines of /ds/README.md ---')
      const lines = (await fs.promises.readFile('/ds/README.md', 'utf-8')).split('\n')
      for (const [i, line] of lines.slice(0, 5).entries()) {
        console.log(`  [${String(i)}] ${line.trimEnd().slice(0, 100)}`)
      }
    }

    if (rootEntries.includes('data') && (await fs.promises.stat('/ds/data')).isDirectory()) {
      console.log("\n--- fs.readdir('/ds/data') (first 5) ---")
      for (const e of (await fs.promises.readdir('/ds/data')).slice(0, 5)) console.log(`  ${e}`)
    }

    console.log('\n--- shell view ---')
    const ls = await ws.shell('ls /ds/')
    console.log(`  ls /ds/: ${ls.stdoutText.trim()}`)
    const shards = await ws.shell("find /ds/ -name '*.parquet' | head -n 3")
    console.log(`  parquet shards (first 3): ${shards.stdoutText.trim()}`)
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
