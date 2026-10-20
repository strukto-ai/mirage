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
  EmailVFS,
  Mount,
  MountBackend,
  MountMode,
  Workspace,
  buildEmailConfig,
  type EmailConfig,
} from '@struktoai/mirage-node'

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

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const vfs = new EmailVFS(buildConfig())
  const ws = new Workspace({
    '/email/': new Mount(vfs, { mode: MountMode.READ, backend: MountBackend.FUSE }),
  })
  await ws.fuseReady()
  const mp = ws.fuseMountpoint as string
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`)

    // Async fs only: this process serves the mount, so a sync call on
    // the mountpoint would block the event loop that answers it.
    console.log('--- fs.promises.readdir() folders ---')
    const folders = await readdir(mp)
    for (const f of folders) {
      console.log(`  ${f}`)
    }

    let folder = 'Inbox'
    if (!folders.some((f) => f.includes('Inbox') || f.includes('INBOX'))) {
      folder = folders[0] ?? ''
    }

    const folderPath = `${mp}/${folder}`
    if (await isDir(folderPath)) {
      console.log(`\n--- fs.promises.readdir() ${folder} (dates) ---`)
      const dates = await readdir(folderPath)
      for (const d of dates.slice(0, 5)) {
        console.log(`  ${d}`)
      }

      const firstDate = dates[0]
      if (firstDate !== undefined) {
        const datePath = `${folderPath}/${firstDate}`
        console.log(`\n--- fs.promises.readdir() ${firstDate} ---`)
        const messages = await readdir(datePath)
        for (const m of messages.slice(0, 5)) {
          console.log(`  ${m}`)
        }

        const first = messages.find((m) => m.endsWith('.email.json'))
        if (first !== undefined) {
          console.log(`\n--- fs.promises.readFile() ${first.slice(0, 60)} ---`)
          const content = await readFile(`${datePath}/${first}`, 'utf-8')
          const parsed = JSON.parse(content) as { subject?: string; from?: unknown }
          console.log(`  subject: ${parsed.subject ?? 'N/A'}`)
          console.log(`  from: ${JSON.stringify(parsed.from ?? 'N/A')}`)
        }
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`)
    console.log('>>> Open another terminal and run:')
    console.log(`>>>   ls ${mp}/`)
    console.log(`>>>   ls ${mp}/${folder}/`)
    console.log('>>> Press Enter to unmount and exit...')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('')
    rl.close()

    const total = ws.records.reduce((acc, r) => acc + r.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
