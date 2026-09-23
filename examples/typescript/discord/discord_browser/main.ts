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

import { DiscordVFS, MountMode, Workspace } from '@struktoai/mirage-browser'

const PROXY_URL = process.env.DISCORD_PROXY_URL ?? 'http://127.0.0.1:8902/api/discord'

async function main(): Promise<void> {
  const discord = new DiscordVFS({ proxyUrl: PROXY_URL })
  const ws = new Workspace({ '/discord': discord }, { mode: MountMode.READ })
  try {
    console.log(`=== BROWSER MODE: DiscordVFS → ${PROXY_URL} ===\n`)

    console.log('=== ls /discord/ (guilds) ===')
    let r = await ws.shell('ls /discord/')
    console.log(r.stdoutText)

    const guilds = r.stdoutText.trim() === '' ? [] : r.stdoutText.trim().split('\n')
    if (guilds.length === 0) {
      console.log('no guilds found')
      return
    }
    const guild = guilds[0]!.trim()

    console.log(`=== ls /discord/${guild}/channels/ | head -n 3 ===`)
    r = await ws.shell(`ls "/discord/${guild}/channels/" | head -n 3`)
    console.log(r.stdoutText)

    r = await ws.shell(`ls "/discord/${guild}/channels/" | head -n 1`)
    const firstCh = r.stdoutText.trim()
    if (firstCh === '') {
      console.log('no channels found')
      return
    }
    const base = `/discord/${guild}/channels/${firstCh}`

    console.log(`=== ls ${base}/ | tail -n 3 ===`)
    r = await ws.shell(`ls "${base}/" | tail -n 3`)
    console.log(r.stdoutText)

    r = await ws.shell(`ls "${base}/" | tail -n 1`)
    const target = r.stdoutText.trim()
    if (target !== '') {
      const filePath = `${base}/${target}`
      console.log(`=== head -n 2 ${filePath} ===`)
      r = await ws.shell(`head -n 2 "${filePath}"`)
      const out = r.stdoutText.trim()
      if (out !== '') {
        for (const line of out.split('\n')) {
          console.log(`  ${line.slice(0, 120)}`)
        }
      } else {
        console.log('  (empty)')
      }

      console.log(`\n=== wc -l ${filePath} ===`)
      r = await ws.shell(`wc -l "${filePath}"`)
      console.log(`  ${r.stdoutText.trim()}`)
    }

    console.log(`\n=== tree -L 1 /discord/${guild}/ ===`)
    r = await ws.shell(`tree -L 1 "/discord/${guild}/"`)
    const treeOut = r.stdoutText.trim()
    if (treeOut !== '') {
      for (const line of treeOut.split('\n')) {
        console.log(`  ${line}`)
      }
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
