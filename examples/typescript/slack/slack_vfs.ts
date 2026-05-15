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
import dotenv from 'dotenv'
import {
  MountMode,
  patchNodeFs,
  SlackResource,
  Workspace,
  type SlackConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

dotenv.config({ path: '.env.development' })

function buildConfig(): SlackConfig {
  const token = process.env.SLACK_BOT_TOKEN
  if (token === undefined || token === '') {
    throw new Error('SLACK_BOT_TOKEN env var is required')
  }
  return { token }
}

async function main(): Promise<void> {
  const resource = new SlackResource(buildConfig())
  const ws = new Workspace({ '/slack': resource }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from Slack transparently ===\n')

    console.log('--- fs.readdir() root ---')
    const sections = await fs.promises.readdir('/slack')
    for (const s of sections) {
      console.log(`  ${s}`)
    }

    console.log('\n--- fs.readdir() channels ---')
    const channels = await fs.promises.readdir('/slack/channels')
    for (const ch of channels.slice(0, 5)) {
      console.log(`  ${ch}`)
    }

    let path = ''
    if (channels.length > 0) {
      const ch = channels.find((c) => c.includes('general')) ?? channels[0]!
      console.log('\n--- fs.readdir() dates ---')
      const dates = await fs.promises.readdir(`/slack/channels/${ch}`)
      for (const d of dates.slice(-5)) {
        console.log(`  ${d}`)
      }

      if (dates.length > 0) {
        let found = false
        for (const d of [...dates].reverse()) {
          path = `/slack/channels/${ch}/${d}/chat.jsonl`
          const content = await fs.promises.readFile(path, 'utf-8')
          const lines = content
            .trim()
            .split('\n')
            .filter((line) => line.trim() !== '')
          if (lines.length > 0) {
            console.log(`\n--- fs.readFile() ${d} ---`)
            console.log(`  messages: ${String(lines.length)}`)
            for (const line of lines.slice(0, 3)) {
              try {
                const rec = JSON.parse(line) as { user?: string; text?: string }
                const user = rec.user ?? '?'
                const text = (rec.text ?? '').slice(0, 80)
                console.log(`  [${user}] ${text}`)
              } catch {
                console.log(`  (unparseable: ${line.slice(0, 80)})`)
              }
            }
            found = true
            break
          }
        }
        if (!found) {
          console.log('\n  (no messages found in recent dates)')
        }

        console.log('\n--- existsSync() ---')
        console.log(`  exists: ${String(fs.existsSync(path))}`)
        console.log(`  nonexistent: ${String(fs.existsSync('/slack/channels/nope'))}`)
      }
    }

    console.log('\n--- session observer ---')
    const dayFolders = await fs.promises.readdir('/.sessions')
    const dayFolder = dayFolders[0]
    const logEntries = dayFolder !== undefined
      ? await fs.promises.readdir(`/.sessions/${dayFolder}`)
      : []
    for (const e of logEntries) {
      console.log(`  ${e}`)
    }
    if (dayFolder !== undefined && logEntries.length > 0) {
      const text = await fs.promises.readFile(`/.sessions/${dayFolder}/${logEntries[0]!}`, 'utf-8')
      const lines = text.split('\n').filter((line) => line.trim() !== '')
      for (let i = 0; i < Math.min(3, lines.length); i++) {
        console.log(`  [${String(i)}] ${lines[i]!.slice(0, 120)}`)
      }
    }

    const records = ws.records
    const total = records.reduce((acc, r) => acc + (r.bytes ?? 0), 0)
    console.log(
      `\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`,
    )
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
