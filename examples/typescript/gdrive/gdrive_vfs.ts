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
  GDriveResource,
  MountMode,
  patchNodeFs,
  Workspace,
  type GDriveConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): GDriveConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

async function main(): Promise<void> {
  const resource = new GDriveResource(buildConfig())
  const ws = new Workspace({ '/gdrive/': resource }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from Google Drive transparently ===\n')

    console.log('--- fs.readdir() root ---')
    const entries = await fs.promises.readdir('/gdrive')
    for (const e of entries.slice(0, 10)) console.log(`  ${e}`)
    if (entries.length > 10) console.log(`  ... (${String(entries.length)} total)`)

    if (entries.length > 0) {
      const first = entries[0]!
      const path = `/gdrive/${first}`
      console.log(`\n--- fs.promises.stat(${path}) ---`)
      const stat = await fs.promises.stat(path)
      console.log(`  isDirectory: ${String(stat.isDirectory())}`)
      console.log(`  isFile: ${String(stat.isFile())}`)
      console.log(`  size: ${String(stat.size)}`)

      if (stat.isFile()) {
        console.log(`\n--- open() + read ${path} (first 200 bytes) ---`)
        const content = await fs.promises.readFile(path, 'utf-8')
        console.log(`  ${content.slice(0, 200)}...`)
      } else if (stat.isDirectory()) {
        console.log(`\n--- fs.readdir(${path}) ---`)
        const sub = await fs.promises.readdir(path)
        for (const s of sub.slice(0, 5)) console.log(`  ${s}`)
      }
    }

    const records = ws.records
    const total = records.reduce((s, r) => s + (r.bytes ?? 0), 0)
    console.log(`\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
