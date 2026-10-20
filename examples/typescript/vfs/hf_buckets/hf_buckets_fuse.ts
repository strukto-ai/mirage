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

import { readdir, readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  HfBucketsVFS,
  Mount,
  MountBackend,
  MountMode,
  Workspace,
  type HfBucketsConfig,
} from '@struktoai/mirage-node'

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
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const vfs = new HfBucketsVFS(buildConfig())
  const ws = new Workspace({
    '/hf/': new Mount(vfs, { mode: MountMode.READ, backend: MountBackend.FUSE }),
  })
  await ws.fuseReady()
  const mp = ws.fuseMountpoint as string
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`)

    console.log(`--- readdir(${mp}) ---`)
    const rootEntries = await readdir(mp)
    for (const e of rootEntries) console.log(`  ${e}`)

    let dataDir = mp
    if (rootEntries.includes('data') && (await isDir(`${mp}/data`))) {
      dataDir = `${mp}/data`
      console.log(`\n--- readdir(${dataDir}) ---`)
      for (const e of await readdir(dataDir)) console.log(`  ${e}`)
    }

    const dataEntries = await readdir(dataDir)
    const entry = dataEntries.find((e) => e.endsWith('.jsonl') || e.endsWith('.json'))
    const target = entry !== undefined ? `${dataDir}/${entry}` : null

    if (target !== null) {
      console.log(`\n--- readFile(${target}) + read 3 lines ---`)
      // Split after each newline so the lines match a file iterator's.
      const lines = (await readFile(target, 'utf-8')).split(/(?<=\n)/)
      lines.slice(0, 3).forEach((line, i) => {
        console.log(`  [${String(i)}] ${line.trim().slice(0, 100)}`)
      })

      console.log(`\n--- stat(${target}).size ---`)
      const size = (await stat(target)).size
      console.log(`  size: ${String(size)} bytes`)
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`)
    console.log('>>> Open another terminal and run:')
    console.log(`>>>   ls ${mp}/data/`)
    if (target !== null) console.log(`>>>   cat ${target}`)
    console.log('>>> Press Enter to unmount and exit...')

    // A closed stdin (EOF) also unmounts, as Enter does.
    const rl = createInterface({ input: process.stdin })
    await new Promise<void>((done) => {
      rl.once('line', () => done())
      rl.once('close', () => done())
    })
    rl.close()

    const records = ws.records
    const total = records.reduce((sum, r) => sum + r.bytes, 0)
    console.log(`\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
