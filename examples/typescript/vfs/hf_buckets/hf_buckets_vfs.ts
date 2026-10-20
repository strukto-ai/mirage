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
  HfBucketsVFS,
  MountMode,
  patchNodeFs,
  Workspace,
  type HfBucketsConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): HfBucketsConfig {
  const bucket = process.env.HF_BUCKET_NAME
  const token = process.env.HF_TOKEN
  if (bucket === undefined || token === undefined) {
    throw new Error('HF_BUCKET_NAME and HF_TOKEN are required')
  }
  return { bucket, token }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const vfs = new HfBucketsVFS(buildConfig())
  const ws = new Workspace({ '/hf/': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS: fs.readFile() reads from HF Bucket transparently ===')

    console.log("\n--- fs.promises.readdir('/hf') ---")
    const rootEntries = await fs.promises.readdir('/hf')
    for (const e of rootEntries) console.log(`  ${e}`)

    let dataDir = '/hf'
    if (rootEntries.includes('data') && (await isDir('/hf/data'))) {
      dataDir = '/hf/data'
      console.log(`\n--- fs.promises.readdir('${dataDir}') ---`)
      for (const e of await fs.promises.readdir(dataDir)) console.log(`  ${e}`)
    }

    const entries = await fs.promises.readdir(dataDir)
    const entry = entries.find((e) => e.endsWith('.jsonl') || e.endsWith('.json'))
    const target = entry !== undefined ? `${dataDir}/${entry}` : null

    if (target !== null) {
      console.log(`\n--- read first 3 lines of ${target} ---`)
      // Split after each newline so the lines match a file iterator's.
      const lines = (await fs.promises.readFile(target, 'utf-8')).split(/(?<=\n)/)
      lines.slice(0, 3).forEach((line, i) => {
        console.log(`  [${String(i)}] ${line.trim().slice(0, 100)}`)
      })
    }

    console.log('\n--- VFS commands ---')
    let r = await ws.shell(`ls ${dataDir}`)
    console.log(`  ls ${dataDir}: ${r.stdoutText.trim()}`)
    if (target !== null) {
      r = await ws.shell(`head -n 3 ${target}`)
      console.log(`  head -n 3:\n${r.stdoutText.trimEnd()}`)
      r = await ws.shell(`wc -l ${target}`)
      console.log(`  wc -l: ${r.stdoutText.trim()}`)
    }
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
