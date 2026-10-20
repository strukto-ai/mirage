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
  HfModelsVFS,
  MountMode,
  patchNodeFs,
  Workspace,
  type HfModelsConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function configFromEnv(): HfModelsConfig {
  return {
    repoId: process.env.HF_MODEL_REPO ?? 'sapientinc/HRM-Text-1B',
    ...(process.env.HF_TOKEN !== undefined ? { token: process.env.HF_TOKEN } : {}),
  }
}

async function main(): Promise<void> {
  const vfs = new HfModelsVFS(configFromEnv())
  const ws = new Workspace({ '/m/': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log(`=== VFS: ${vfs.accessor.bucketUri} ===`)

    console.log("\n--- fs.readdir('/m') ---")
    const rootEntries = await fs.promises.readdir('/m')
    for (const e of rootEntries) console.log(`  ${e}`)

    if (rootEntries.includes('config.json')) {
      console.log('\n--- read /m/config.json + parse ---')
      const cfg = JSON.parse(await fs.promises.readFile('/m/config.json', 'utf-8')) as Record<
        string,
        unknown
      >
      for (const k of ['model_type', 'architectures', 'hidden_size', 'num_hidden_layers']) {
        if (!(k in cfg)) continue
        const value = cfg[k]
        console.log(`  ${k}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      }
    }

    const weightFiles = rootEntries.filter((e) => e.endsWith('.safetensors'))
    if (weightFiles.length > 0) {
      console.log('\n--- weights present (sizes only, not downloaded) ---')
      for (const wf of weightFiles.slice(0, 5)) {
        const { size } = await fs.promises.stat(`/m/${wf}`)
        console.log(`  ${wf}: ${size.toLocaleString('en-US').padStart(12)} bytes`)
      }
    }

    console.log('\n--- shell view ---')
    console.log((await ws.shell('ls -lh /m/')).stdoutText)
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
