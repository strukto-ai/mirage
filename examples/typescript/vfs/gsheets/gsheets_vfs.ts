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
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): GSheetsConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

const exists = (p: string): Promise<boolean> =>
  fs.promises.stat(p).then(
    () => true,
    () => false,
  )

async function main(): Promise<void> {
  const vfs = new GSheetsVFS(buildConfig())
  const ws = new Workspace({ '/gsheets/': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from Google Sheets transparently ===\n')

    console.log('--- fs.readdir() root ---')
    for (const d of await fs.promises.readdir('/gsheets')) console.log(`  ${d}`)

    console.log('\n--- fs.readdir() owned ---')
    const sheets = await fs.promises.readdir('/gsheets/owned')
    for (const s of sheets.slice(0, 5)) console.log(`  ${s}`)

    if (sheets.length > 0) {
      const first = sheets[0]!
      const path = `/gsheets/owned/${first}`
      console.log('\n--- fs.readFile() first spreadsheet ---')
      const content = await fs.promises.readFile(path, 'utf-8')
      const parsed = JSON.parse(content) as {
        properties?: { title?: string }
        sheets?: unknown[]
      }
      console.log(`  title: ${parsed.properties?.title ?? 'N/A'}`)
      console.log(`  sheets: ${String(parsed.sheets?.length ?? 0)}`)
      console.log(`  preview: ${content.slice(0, 200)}...`)

      console.log('\n--- exists via fs.promises.stat() ---')
      console.log(`  ${first}: ${String(await exists(path))}`)
      console.log(`  nonexistent: ${String(await exists('/gsheets/owned/nope.json'))}`)
    }

    console.log('\n--- bash history ---')
    const history = await fs.promises.readFile('/.bash_history', 'utf-8')
    const lines = history.split('\n').filter((line) => line.trim() !== '')
    for (const line of lines.slice(0, 6)) console.log(`  ${line.slice(0, 120)}`)

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
