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
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  GCSVFS,
  Mount,
  MountBackend,
  MountMode,
  Workspace,
  type GCSConfig,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function configFromEnv(): GCSConfig {
  const bucket = process.env.GCS_BUCKET
  const accessKeyId = process.env.GCS_ACCESS_KEY_ID
  const secretAccessKey = process.env.GCS_SECRET_ACCESS_KEY
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      'GCS_BUCKET, GCS_ACCESS_KEY_ID, GCS_SECRET_ACCESS_KEY must be set (e.g. in .env.development)',
    )
  }
  return { bucket, accessKeyId, secretAccessKey }
}

async function main(): Promise<void> {
  const vfs = new GCSVFS(configFromEnv())
  const ws = new Workspace({
    '/gcs/': new Mount(vfs, { mode: MountMode.READ, backend: MountBackend.FUSE }),
  })
  await ws.fuseReady()
  const mp = ws.fuseMountpoint as string
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`)

    // Async fs only: this process serves the mount, so a sync call on
    // the mountpoint would block the event loop that answers it.
    console.log('--- fs.promises.readdir() ---')
    for (const e of await readdir(`${mp}/data`)) {
      console.log(`  ${e}`)
    }

    console.log('\n--- fs.promises.readFile() example.json (first 5 lines) ---')
    const json = await readFile(`${mp}/data/example.json`, 'utf-8')
    for (const line of json.split('\n').slice(0, 5)) {
      console.log(`  ${line.trimEnd().slice(0, 120)}`)
    }

    console.log('\n--- fs.promises.readFile() example.jsonl (first 3 lines) ---')
    const jsonl = await readFile(`${mp}/data/example.jsonl`, 'utf-8')
    for (const [i, line] of jsonl.split('\n').slice(0, 3).entries()) {
      const rec = JSON.parse(line) as unknown
      console.log(`  [${String(i)}] ${JSON.stringify(rec).slice(0, 100)}...`)
    }

    console.log('\n--- fs.promises.stat() size ---')
    const st = await stat(`${mp}/data/example.json`)
    console.log(`  example.json: ${String(st.size)} bytes`)

    console.log(`\n>>> FUSE mounted at: ${mp}`)
    console.log('>>> Open another terminal and run:')
    console.log(`>>>   ls ${mp}/data/`)
    console.log(`>>>   cat ${mp}/data/example.json`)
    console.log('>>> Press Enter to unmount and exit...')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('')
    rl.close()

    const total = ws.records.reduce((acc, r) => acc + r.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(total)} bytes`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
