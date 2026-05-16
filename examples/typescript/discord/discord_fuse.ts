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

import { readdir, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import dotenv from 'dotenv'
import {
  DiscordResource,
  FuseManager,
  MountMode,
  Workspace,
  type DiscordConfig,
} from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function buildConfig(): DiscordConfig {
  const token = process.env.DISCORD_BOT_TOKEN
  if (token === undefined || token === '') {
    throw new Error('DISCORD_BOT_TOKEN env var is required')
  }
  return { token }
}

async function main(): Promise<void> {
  const resource = new DiscordResource(buildConfig())
  const ws = new Workspace({ '/discord': resource }, { mode: MountMode.READ })
  const fm = new FuseManager()
  const mp = await fm.setup(ws)
  let cleaned = false
  const handler = (sig: NodeJS.Signals): void => {
    if (cleaned) return
    cleaned = true
    void (async (): Promise<void> => {
      try { await fm.close(ws) } catch {}
      try { await ws.close() } catch {}
      console.error(`\n>>> unmounted ${mp}`)
      process.exit(sig === "SIGINT" ? 130 : 143)
    })()
  }
  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)
  try {
    console.log(`=== FUSE MODE: mounted at ${mp} ===\n`)

    console.log('--- readdir() guilds ---')
    const guilds = await readdir(`${mp}/discord`)
    for (const g of guilds) {
      console.log(`  ${g}`)
    }

    if (guilds.length === 0) {
      console.log('no guilds found')
    } else {
      const guild = guilds[0]!

      console.log(`\n--- readdir() ${guild} ---`)
      const contents = await readdir(`${mp}/discord/${guild}`)
      for (const c of contents) {
        console.log(`  ${c}`)
      }

      console.log(`\n--- readdir() ${guild}/channels ---`)
      const channels = await readdir(`${mp}/discord/${guild}/channels`)
      for (const ch of channels) {
        console.log(`  ${ch}`)
      }

      if (channels.length > 0) {
        const ch = channels[0]!

        console.log(`\n--- readdir() ${ch} (last 5 dates) ---`)
        const dates = await readdir(`${mp}/discord/${guild}/channels/${ch}`)
        for (const d of dates.slice(-5)) {
          console.log(`  ${d}`)
        }

        if (dates.length > 0) {
          const target = dates[dates.length - 1]!
          const dateDir = `${mp}/discord/${guild}/channels/${ch}/${target}`
          const chatPath = `${dateDir}/chat.jsonl`
          console.log(`\n--- readFile() ${target}/chat.jsonl ---`)
          const text = (await readFile(chatPath, 'utf-8')).trim()
          if (text !== '') {
            const lines = text.split('\n').filter((ln) => ln.trim() !== '')
            for (let i = 0; i < lines.length; i++) {
              if (i >= 5) {
                console.log('  ...')
                break
              }
              try {
                const msg = JSON.parse(lines[i]!) as {
                  author?: { username?: string }
                  content?: string
                }
                const author = msg.author?.username ?? '?'
                const content = (msg.content ?? '').slice(0, 80)
                console.log(`  [${author}] ${content}`)
              } catch {
                break
              }
            }
          } else {
            console.log('  (empty — no messages on this date)')
          }
          try {
            const atts = await readdir(`${dateDir}/files`)
            if (atts.length > 0) {
              console.log(`\n--- readdir() ${target}/files ---`)
              for (const a of atts.slice(0, 5)) console.log(`  ${a}`)
            }
          } catch {
            // no files dir
          }
        }
      }

      console.log(`\n--- readdir() ${guild}/members ---`)
      const members = await readdir(`${mp}/discord/${guild}/members`)
      for (const m of members.slice(0, 5)) {
        console.log(`  ${m}`)
      }

      if (members.length > 0) {
        const memberPath = `${mp}/discord/${guild}/members/${members[0]!}`
        console.log(`\n--- readFile() ${members[0]!} ---`)
        const text = (await readFile(memberPath, 'utf-8')).trim()
        if (text !== '') {
          try {
            const data = JSON.parse(text) as {
              user?: { username?: string; id?: string }
            }
            console.log(`  username: ${String(data.user?.username)}`)
            console.log(`  id: ${String(data.user?.id)}`)
          } catch {
            console.log(`  (raw: ${text.slice(0, 100)})`)
          }
        } else {
          console.log('  (empty)')
        }
      }
    }

    console.log(`\n>>> FUSE mounted at: ${mp}`)
    console.log('>>> Open another terminal and run:')
    console.log(`>>>   ls ${mp}/discord/`)
    console.log(`>>>   cat ${mp}/discord/<guild>/channels/<ch>/<date>/chat.jsonl`)
    console.log('>>> Press Enter to unmount and exit...')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('')
    rl.close()

    const records = ws.records
    const total = records.reduce((acc, r) => acc + (r.bytes ?? 0), 0)
    console.log(
      `\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`,
    )
  } finally {
    await fm.close()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
