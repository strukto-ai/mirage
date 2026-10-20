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
import { GCSVFS, MountMode, Workspace, patchNodeFs, type GCSConfig } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p)
    return true
  } catch {
    return false
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/gcs/': new GCSVFS(configFromEnv()) }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from GCS transparently ===\n')

    console.log('--- fs.readdir() root ---')
    for (const e of await fs.promises.readdir('/gcs')) {
      console.log(`  ${e}`)
    }

    console.log('\n--- isDir() on prefix ---')
    console.log(`  /gcs/data: ${String(await isDir('/gcs/data'))}`)

    console.log('\n--- fs.readdir() data ---')
    for (const e of await fs.promises.readdir('/gcs/data')) {
      console.log(`  ${e}`)
    }

    console.log('\n--- fs.readFile() example.json (first 5 lines) ---')
    const json = await fs.promises.readFile('/gcs/data/example.json', 'utf-8')
    for (const line of json.split('\n').slice(0, 5)) {
      console.log(`  ${line.trimEnd().slice(0, 120)}`)
    }

    console.log('\n--- fs.readFile() example.jsonl (first 3 lines) ---')
    const jsonl = await fs.promises.readFile('/gcs/data/example.jsonl', 'utf-8')
    for (const [i, line] of jsonl.split('\n').slice(0, 3).entries()) {
      const rec = JSON.parse(line) as unknown
      console.log(`  [${String(i)}] ${JSON.stringify(rec).slice(0, 100)}...`)
    }

    console.log('\n--- exists via fs.promises.stat() ---')
    console.log(`  example.json: ${String(await exists('/gcs/data/example.json'))}`)
    console.log(`  nonexistent: ${String(await exists('/gcs/data/nope.txt'))}`)

    console.log('\n--- VFS commands ---')
    const result = await ws.shell('grep -c mirage /gcs/data/example.jsonl')
    console.log(`  grep matches: ${result.stdoutText.trim()}`)

    console.log('\n--- bash history ---')
    const history = await fs.promises.readFile('/.bash_history', 'utf-8')
    const histLines = history.split('\n').filter((line) => line.trim() !== '')
    for (const line of histLines.slice(0, 6)) {
      console.log(`  ${line.trimEnd().slice(0, 120)}`)
    }

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
