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

import { createReadStream } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { createInterface as createPrompt } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  Mount,
  MountBackend,
  MountMode,
  S3VFS,
  Workspace,
  patchNodeFs,
  type S3Config,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function baseConfig(): S3Config {
  const bucket = process.env.AWS_S3_BUCKET
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      'AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY must be set (e.g. in .env.development)',
    )
  }
  return {
    bucket,
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
  }
}

// Streams only the head of a file through the kernel mount, the way
// Python's line iteration stops reading once it breaks.
async function firstLines(path: string, count: number): Promise<string[]> {
  const stream = createReadStream(path, 'utf-8')
  const lines: string[] = []
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      lines.push(line)
      if (lines.length >= count) break
    }
  } finally {
    stream.destroy()
  }
  return lines
}

async function main(): Promise<void> {
  const config = baseConfig()
  const deepConfig: S3Config = { ...config, keyPrefix: 'subdata/subsubdata/' }
  const ws = new Workspace({
    '/s3/': new Mount(new S3VFS(config), { mode: MountMode.READ, backend: MountBackend.FUSE }),
    '/deep/': new S3VFS(deepConfig),
  })
  await ws.fuseReady()
  const mp = ws.fuseMountpoint as string
  const restore = patchNodeFs(ws)
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`)

    // Async fs only: this process serves the mount, so a sync call on
    // the mountpoint would block the event loop that answers it.
    console.log('--- fs.promises.readdir() ---')
    for (const e of await fs.promises.readdir(`${mp}/data`)) {
      console.log(`  ${e}`)
    }

    console.log('\n--- createReadStream() + read ---')
    for (const [i, line] of (await firstLines(`${mp}/data/example.jsonl`, 3)).entries()) {
      console.log(`  [${String(i)}] ${line.trim().slice(0, 100)}...`)
    }

    console.log('\n--- fs.promises.stat() size ---')
    const size = (await fs.promises.stat(`${mp}/data/example.jsonl`)).size
    console.log(`  size: ${String(size)} bytes`)

    // Only /s3/ is kernel-mounted, so the mountpoint is the bucket root.
    // /deep/ stays virtual: patchNodeFs routes its paths through the
    // workspace, in this process.
    console.log('\n=== KEY_PREFIX MOUNT (/deep → subdata/subsubdata/) ===')
    console.log(`  keyPrefix = ${JSON.stringify(deepConfig.keyPrefix)}\n`)

    console.log("--- fs.promises.readdir('/deep') ---")
    for (const e of await fs.promises.readdir('/deep')) {
      console.log(`  ${e}`)
    }

    console.log("\n--- fs.promises.readFile('/deep/example.jsonl') + read 3 lines ---")
    const deepText = await fs.promises.readFile('/deep/example.jsonl', 'utf-8')
    for (const [i, line] of deepText.split('\n').slice(0, 3).entries()) {
      console.log(`  [${String(i)}] ${line.trim().slice(0, 100)}...`)
    }

    console.log("\n--- fs.promises.stat('/deep/example.jsonl') size ---")
    const deepSize = (await fs.promises.stat('/deep/example.jsonl')).size
    console.log(`  size: ${String(deepSize)} bytes`)
    console.log('  (resolves to s3://bucket/subdata/subsubdata/example.jsonl)')

    console.log(`\n>>> FUSE mounted at: ${mp}`)
    console.log('>>> Open another terminal and run:')
    console.log(`>>>   ls ${mp}/data/`)
    console.log(`>>>   ls ${mp}/subdata/subsubdata/`)
    console.log(`>>>   cat ${mp}/subdata/subsubdata/example.json`)
    console.log('>>> Press Enter to unmount and exit...')

    const rl = createPrompt({ input: process.stdin, output: process.stdout })
    await rl.question('')
    rl.close()

    const total = ws.records.reduce((acc, r) => acc + r.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
