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
  GoogleDriveVFS,
  MountMode,
  patchNodeFs,
  Workspace,
  type GDriveConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): GDriveConfig {
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

async function readJson<T>(path: string): Promise<{ content: string; parsed: T }> {
  const content = await fs.promises.readFile(path, 'utf-8')
  return { content, parsed: JSON.parse(content) as T }
}

async function main(): Promise<void> {
  const vfs = new GoogleDriveVFS(buildConfig())
  const ws = new Workspace({ '/gdrive/': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE ===\n')

    console.log('--- fs.readdir() root ---')
    const entries = await fs.promises.readdir('/gdrive')
    for (const e of entries.slice(0, 10)) console.log(`  ${e}`)

    if (entries.length > 0) {
      const first = entries[0]!
      const path = `/gdrive/${first}`
      const stat = await fs.promises.stat(path)
      console.log(`\n--- isDirectory(${first}) ---`)
      console.log(`  ${String(stat.isDirectory())}`)

      if (stat.isFile()) {
        console.log(`\n--- fs.readFile() ${first} ---`)
        const content = await fs.promises.readFile(path, 'utf-8')
        console.log(`  ${String(content.length)} bytes`)
      }
    }

    // Docs, Sheets and Slides render to JSON with their own shapes.
    const gdoc = entries.find((e) => e.endsWith('.gdoc.json'))
    const gsheet = entries.find((e) => e.endsWith('.gsheet.json'))
    const gslide = entries.find((e) => e.endsWith('.gslide.json'))

    if (gdoc !== undefined) {
      console.log(`\n--- fs.readFile() Google Doc: ${gdoc} ---`)
      const { content, parsed } = await readJson<{ title?: string }>(`/gdrive/${gdoc}`)
      console.log(`  title: ${parsed.title ?? 'N/A'}`)
      console.log(`  preview: ${content.slice(0, 200)}...`)
    }

    if (gsheet !== undefined) {
      console.log(`\n--- fs.readFile() Google Sheet: ${gsheet} ---`)
      const { parsed } = await readJson<{ properties?: { title?: string }; sheets?: unknown[] }>(
        `/gdrive/${gsheet}`,
      )
      console.log(`  title: ${parsed.properties?.title ?? 'N/A'}`)
      console.log(`  sheets: ${String(parsed.sheets?.length ?? 0)}`)
    }

    if (gslide !== undefined) {
      console.log(`\n--- fs.readFile() Google Slides: ${gslide} ---`)
      const { parsed } = await readJson<{ title?: string; slides?: unknown[] }>(`/gdrive/${gslide}`)
      console.log(`  title: ${parsed.title ?? 'N/A'}`)
      console.log(`  slides: ${String(parsed.slides?.length ?? 0)}`)
    }

    console.log('\n--- exists via fs.promises.stat() ---')
    if (gdoc !== undefined) console.log(`  ${gdoc}: ${String(await exists(`/gdrive/${gdoc}`))}`)
    console.log(`  nonexistent: ${String(await exists('/gdrive/nope.txt'))}`)

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
