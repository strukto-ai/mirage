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
  GSheetsVFS,
  MountMode,
  patchNodeFs,
  Workspace,
  type GSheetsConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): GSheetsConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

async function main(): Promise<void> {
  const vfs = new GSheetsVFS(buildConfig())
  const ws = new Workspace({ '/gsheets/': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from Google Docs transparently ===\n')

    console.log('--- fs.readdir() root ---')
    const dirs = await fs.promises.readdir('/gsheets')
    for (const d of dirs) console.log(`  ${d}`)

    console.log('\n--- fs.readdir() owned ---')
    const docs = await fs.promises.readdir('/gsheets/owned')
    for (const d of docs.slice(0, 5)) console.log(`  ${d}`)
    if (docs.length > 5) console.log(`  ... (${String(docs.length)} total)`)

    if (docs.length > 0) {
      const first = docs[0]!
      const path = `/gsheets/owned/${first.split('/').pop() ?? first}`
      console.log(`\n--- open() + read first doc ---`)
      const content = await fs.promises.readFile(path, 'utf-8')
      const parsed = JSON.parse(content) as { title?: string }
      console.log(`  title: ${parsed.title ?? 'N/A'}`)
      console.log(`  content preview: ${content.slice(0, 200)}...`)

      console.log('\n--- fs.promises.stat() ---')
      const stat = await fs.promises.stat(path)
      console.log(`  size: ${String(stat.size)}`)
      console.log(`  isFile: ${String(stat.isFile())}`)
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
