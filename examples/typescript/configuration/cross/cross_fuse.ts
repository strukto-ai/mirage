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
import { cp, mkdtemp, open, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

import {
  DiskVFS,
  GmailVFS,
  GoogleDriveVFS,
  NotionVFS,
  S3VFS,
  SlackVFS,
  Workspace,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

const REPO_ROOT = resolve(__HERE, '../../../..')
const DATA_DIR = join(REPO_ROOT, 'data')

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

// Every probe of the mountpoint is async: the mount is served by this
// process's event loop, so a synchronous call into it would deadlock.
function missing(err: NodeJS.ErrnoException): null {
  if (err.code !== 'ENOENT') throw err
  return null
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(missing))?.isFile() ?? false
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(missing))?.isDirectory() ?? false
}

async function readHead(path: string, size: number): Promise<number> {
  const handle = await open(path, 'r')
  try {
    const { bytesRead } = await handle.read(Buffer.alloc(size), 0, size, 0)
    return bytesRead
  } finally {
    await handle.close()
  }
}

async function firstLines(path: string, count: number): Promise<string[]> {
  const stream = createReadStream(path, 'utf-8')
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const out: string[] = []
  for await (const line of lines) {
    out.push(line)
    if (out.length >= count) break
  }
  lines.close()
  stream.destroy()
  return out
}

async function main(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'mirage-cross-'))
  await cp(DATA_DIR, join(tmp, 'files'), { recursive: true })

  const google = {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_REFRESH_TOKEN'),
  }
  const searchToken = process.env.SLACK_USER_TOKEN

  const ws = new Workspace({
    '/notion/': new NotionVFS({ apiKey: env('NOTION_API_KEY') }),
    '/gdrive/': new GoogleDriveVFS(google),
    '/gmail/': new GmailVFS(google),
    '/local/': new DiskVFS({ root: join(tmp, 'files') }),
    '/s3/': new S3VFS({
      bucket: env('AWS_S3_BUCKET'),
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      accessKeyId: env('AWS_ACCESS_KEY_ID'),
      secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
    }),
    '/slack/': new SlackVFS({
      token: env('SLACK_BOT_TOKEN'),
      ...(searchToken !== undefined ? { searchToken } : {}),
    }),
  })
  try {
    // One FUSE mount over the workspace root exposes every backend as a
    // subdirectory of a single real filesystem path.
    const mp = await ws.addFuseMount('/')

    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`)

    console.log('--- readdir() workspace root ---')
    for (const e of (await readdir(mp)).sort()) console.log(`  ${e}/`)

    console.log('\n--- /notion: readdir() pages ---')
    const pages = await readdir(`${mp}/notion/pages`)
    for (const p of pages.slice(0, 5)) console.log(`  ${p}`)
    if (pages[0] !== undefined) {
      const raw = await readFile(`${mp}/notion/pages/${pages[0]}/page.json`, 'utf-8')
      const data = JSON.parse(raw) as { title?: unknown }
      console.log(`  first page title: ${String(data.title ?? null)}`)
    }

    console.log('\n--- /gdrive: readdir() root ---')
    const driveEntries = await readdir(`${mp}/gdrive`)
    for (const e of driveEntries.slice(0, 5)) console.log(`  ${e}`)
    for (const e of driveEntries) {
      const path = `${mp}/gdrive/${e}`
      if (await isFile(path)) {
        console.log(`  read ${e}: ${String(await readHead(path, 1024))} bytes (first 1024)`)
        break
      }
    }

    console.log('\n--- /gmail: readdir() labels ---')
    const labels = await readdir(`${mp}/gmail`)
    for (const lb of labels.slice(0, 5)) console.log(`  ${lb}`)
    const inbox = `${mp}/gmail/INBOX`
    if (await isDir(inbox)) {
      const dates = await readdir(inbox)
      if (dates[0] !== undefined) {
        const messages = await readdir(`${inbox}/${dates[0]}`)
        const jsonMsg = messages.find((m) => m.endsWith('.gmail.json'))
        if (jsonMsg !== undefined) {
          const raw = await readFile(`${inbox}/${dates[0]}/${jsonMsg}`, 'utf-8')
          const parsed = JSON.parse(raw) as { subject?: string; from?: string }
          console.log(`  latest INBOX message (${dates[0]}):`)
          console.log(`    subject: ${parsed.subject ?? 'N/A'}`)
          console.log(`    from: ${parsed.from ?? 'N/A'}`)
        }
      }
    }

    console.log('\n--- /local: readdir() + sizes ---')
    for (const e of await readdir(`${mp}/local`)) {
      const { size } = await stat(`${mp}/local/${e}`)
      console.log(`  ${e.padEnd(30)} ${size.toLocaleString('en-US').padStart(10)} bytes`)
    }

    console.log('\n--- /s3: createReadStream() + read 3 lines ---')
    const s3Lines = await firstLines(`${mp}/s3/data/example.jsonl`, 3)
    s3Lines.forEach((line, i) => {
      console.log(`  [${String(i)}] ${line.trim().slice(0, 100)}...`)
    })

    console.log('\n--- /slack: readdir() channels ---')
    const channels = await readdir(`${mp}/slack/channels`)
    for (const ch of channels.slice(0, 5)) console.log(`  ${ch}`)
    const ch = channels.find((c) => c.includes('general')) ?? channels[0]
    if (ch !== undefined) {
      for (const d of (await readdir(`${mp}/slack/channels/${ch}`)).reverse()) {
        const path = `${mp}/slack/channels/${ch}/${d}/chat.jsonl`
        if (!(await isFile(path))) continue
        const rows = (await readFile(path, 'utf-8')).split('\n').filter((ln) => ln.trim() !== '')
        const texted = rows
          .map((ln) => JSON.parse(ln) as { user?: string; text?: string })
          .filter((m) => (m.text ?? '').trim() !== '')
        const msg = texted.at(-1)
        if (msg !== undefined) {
          console.log(`  latest message in ${ch} (${d}):`)
          console.log(`    [${msg.user ?? '?'}] ${(msg.text ?? '').slice(0, 80)}`)
          break
        }
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`)
    console.log('>>> Open another terminal and run:')
    console.log(`>>>   ls ${mp}/`)
    console.log(`>>>   ls ${mp}/notion/pages/`)
    console.log(`>>>   ls ${mp}/gmail/INBOX/`)
    console.log(`>>>   cat ${mp}/s3/data/example.jsonl | head -n 3`)
    console.log(`>>>   cat ${mp}/local/example.json | jq .`)
    console.log(`>>>   ls ${mp}/slack/channels/`)
    console.log('>>> Press Enter to unmount and exit...')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('')
    rl.close()

    const records = ws.records
    const total = records.reduce((sum, r) => sum + r.bytes, 0)
    console.log(`\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
