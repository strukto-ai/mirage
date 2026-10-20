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
  EmailVFS,
  MountMode,
  Workspace,
  buildEmailConfig,
  patchNodeFs,
  type EmailConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({
  path: resolve(__HERE, '../../../../.env.development'),
  override: true,
})

function buildConfig(): EmailConfig {
  const imapHost = process.env.IMAP_HOST ?? ''
  const smtpHost = process.env.SMTP_HOST ?? ''
  const username = process.env.EMAIL_USERNAME ?? ''
  const password = process.env.EMAIL_PASSWORD ?? ''
  if (imapHost === '' || smtpHost === '' || username === '' || password === '') {
    throw new Error('IMAP_HOST / SMTP_HOST / EMAIL_USERNAME / EMAIL_PASSWORD are required')
  }
  return buildEmailConfig({
    imapHost,
    smtpHost,
    username,
    password,
    maxMessages: 20,
  })
}

function pickFolder(folders: string[]): string {
  return folders.find((f) => f.toLowerCase() === 'inbox') ?? folders[0] ?? ''
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/email/': new EmailVFS(buildConfig()) }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE ===\n')

    console.log('--- fs.readdir() folders ---')
    const folders = await fs.promises.readdir('/email')
    for (const f of folders) {
      console.log(`  ${f}`)
    }

    const folder = pickFolder(folders)
    if (folder === '') {
      console.log('No folders')
      return
    }

    console.log(`\n--- fs.readdir() ${folder} dates ---`)
    const dates = await fs.promises.readdir(`/email/${folder}`)
    for (const d of dates.slice(0, 5)) {
      console.log(`  ${d}`)
    }

    const firstDate = dates[0]
    if (firstDate !== undefined) {
      console.log(`\n--- fs.readdir() ${firstDate} messages ---`)
      const messages = await fs.promises.readdir(`/email/${folder}/${firstDate}`)
      for (const msg of messages.slice(0, 5)) {
        console.log(`  ${msg}`)
      }

      const first = messages.find((m) => m.endsWith('.email.json'))
      if (first !== undefined) {
        const path = `/email/${folder}/${firstDate}/${first}`
        console.log(`\n--- fs.readFile() ${first.slice(0, 60)} ---`)
        const content = await fs.promises.readFile(path, 'utf-8')
        const parsed = JSON.parse(content) as { subject?: string; from?: unknown }
        console.log(`  subject: ${parsed.subject ?? 'N/A'}`)
        console.log(`  from: ${JSON.stringify(parsed.from ?? 'N/A')}`)

        console.log('\n--- exists via fs.promises.stat() ---')
        console.log(`  ${first}: ${String(await exists(path))}`)
        console.log(`  nope.txt: ${String(await exists(`/email/${folder}/nope.txt`))}`)
      }
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
