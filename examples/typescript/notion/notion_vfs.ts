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
  MountMode,
  NotionVFS,
  patchNodeFs,
  Workspace,
  type NotionConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): NotionConfig {
  const apiKey = process.env.NOTION_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error('NOTION_API_KEY env var is required')
  }
  return { apiKey }
}

async function main(): Promise<void> {
  const vfs = new NotionVFS(buildConfig())
  const ws = new Workspace({ '/notion': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from Notion transparently ===\n')

    console.log('--- fs.readdir() /notion ---')
    for (const e of await fs.promises.readdir('/notion')) console.log(`  ${e}`)

    console.log('\n--- fs.readdir() /notion/pages ---')
    const pages = await fs.promises.readdir('/notion/pages')
    for (const p of pages.slice(0, 5)) console.log(`  ${p}`)

    if (pages.length === 0) {
      console.log('  (no pages)')
      return
    }
    const pagePath = `/notion/pages/${pages[0]!}`

    console.log(`\n--- fs.readdir() ${pagePath} ---`)
    for (const c of await fs.promises.readdir(pagePath)) console.log(`  ${c}`)

    console.log('\n--- fs.readFile() page.json ---')
    const bytes = await fs.promises.readFile(`${pagePath}/page.json`, 'utf-8')
    const data = JSON.parse(bytes) as { title?: string; url?: string; markdown?: string }
    console.log(`  title: ${data.title ?? ''}`)
    console.log(`  url: ${data.url ?? ''}`)
    console.log(`  markdown (first 200 chars): ${(data.markdown ?? '').slice(0, 200)}`)

    const records = ws.records
    const total = records.reduce((acc, r) => acc + (r.bytes ?? 0), 0)
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
