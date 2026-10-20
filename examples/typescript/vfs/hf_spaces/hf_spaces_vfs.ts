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
  HfSpacesVFS,
  MountMode,
  patchNodeFs,
  Workspace,
  type HfSpacesConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function configFromEnv(): HfSpacesConfig {
  return {
    repoId: process.env.HF_SPACE_REPO ?? 'HuggingFaceBio/carbon-demo',
    ...(process.env.HF_TOKEN !== undefined ? { token: process.env.HF_TOKEN } : {}),
  }
}

async function main(): Promise<void> {
  const vfs = new HfSpacesVFS(configFromEnv())
  const ws = new Workspace({ '/s/': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log(`=== VFS: ${vfs.accessor.bucketUri} ===`)

    console.log("\n--- fs.readdir('/s') ---")
    const rootEntries = await fs.promises.readdir('/s')
    for (const e of rootEntries) console.log(`  ${e}`)

    if (rootEntries.includes('README.md')) {
      console.log('\n--- read first 8 lines of /s/README.md ---')
      const lines = (await fs.promises.readFile('/s/README.md', 'utf-8')).split('\n')
      for (const [i, line] of lines.slice(0, 8).entries()) {
        console.log(`  [${String(i)}] ${line.trimEnd().slice(0, 120)}`)
      }
    }

    if (rootEntries.includes('requirements.txt')) {
      console.log('\n--- /s/requirements.txt ---')
      console.log((await fs.promises.readFile('/s/requirements.txt', 'utf-8')).trimEnd())
    }

    console.log('\n--- shell view ---')
    const r = await ws.shell("find /s/ -name '*.py' | head -n 5")
    console.log(`  python files: ${r.stdoutText.trim()}`)
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
