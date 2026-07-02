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
  patchNodeFs,
  TrelloResource,
  Workspace,
  type TrelloConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): TrelloConfig {
  const apiKey = process.env.TRELLO_API_KEY
  const apiToken = process.env.TRELLO_API_TOKEN
  if (apiKey === undefined || apiKey === '') {
    throw new Error('TRELLO_API_KEY env var is required')
  }
  if (apiToken === undefined || apiToken === '') {
    throw new Error('TRELLO_API_TOKEN env var is required')
  }
  const workspaceId = process.env.TRELLO_WORKSPACE_ID
  return {
    apiKey,
    apiToken,
    ...(workspaceId !== undefined && workspaceId !== '' ? { workspaceId } : {}),
  }
}

const exists = (p: string): Promise<boolean> =>
  fs.promises.stat(p).then(
    () => true,
    () => false,
  )

async function main(): Promise<void> {
  const resource = new TrelloResource(buildConfig())
  const ws = new Workspace({ '/trello': resource }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from Trello transparently ===\n')

    console.log('--- fs.readdir() /trello ---')
    const roots = await fs.promises.readdir('/trello')
    for (const r of roots) console.log(`  ${r}`)

    console.log('\n--- fs.readdir() /trello/workspaces ---')
    const workspaces = await fs.promises.readdir('/trello/workspaces')
    for (const w of workspaces.slice(0, 5)) console.log(`  ${w}`)

    if (workspaces.length === 0) {
      console.log('  (no workspaces)')
      return
    }
    const ws0 = workspaces[0]!

    console.log(`\n--- fs.readdir() ${ws0} ---`)
    const wsChildren = await fs.promises.readdir(`/trello/workspaces/${ws0}`)
    for (const c of wsChildren) console.log(`  ${c}`)

    console.log(`\n--- fs.readFile() workspace.json ---`)
    const wsBytes = await fs.promises.readFile(
      `/trello/workspaces/${ws0}/workspace.json`,
      'utf-8',
    )
    console.log(`  ${wsBytes.trim().slice(0, 200)}`)

    console.log(`\n--- fs.readdir() ${ws0}/boards ---`)
    const boards = await fs.promises.readdir(`/trello/workspaces/${ws0}/boards`)
    for (const b of boards.slice(0, 5)) console.log(`  ${b}`)

    if (boards.length === 0) {
      console.log('  (no boards)')
      return
    }
    const b0 = boards[0]!
    const boardPath = `/trello/workspaces/${ws0}/boards/${b0}`

    console.log(`\n--- fs.readdir() ${b0} ---`)
    const boardChildren = await fs.promises.readdir(boardPath)
    for (const c of boardChildren) console.log(`  ${c}`)

    console.log(`\n--- fs.readFile() board.json ---`)
    const boardBytes = await fs.promises.readFile(`${boardPath}/board.json`, 'utf-8')
    console.log(`  ${boardBytes.trim().slice(0, 200)}`)

    console.log(`\n--- fs.readdir() ${b0}/lists ---`)
    const lists = await fs.promises.readdir(`${boardPath}/lists`)
    for (const l of lists.slice(0, 5)) console.log(`  ${l}`)

    if (lists.length > 0) {
      const l0 = lists[0]!
      const listPath = `${boardPath}/lists/${l0}`

      console.log(`\n--- fs.readdir() ${l0}/cards ---`)
      const cards = await fs.promises.readdir(`${listPath}/cards`)
      for (const c of cards.slice(0, 5)) console.log(`  ${c}`)

      if (cards.length > 0) {
        const c0 = cards[0]!
        const cardPath = `${listPath}/cards/${c0}`

        console.log(`\n--- fs.readFile() ${c0}/card.json ---`)
        const cardBytes = await fs.promises.readFile(`${cardPath}/card.json`, 'utf-8')
        console.log(`  ${cardBytes.trim().slice(0, 300)}`)

        console.log(`\n--- fs.readFile() ${c0}/comments.jsonl ---`)
        const commentsBytes = await fs.promises.readFile(
          `${cardPath}/comments.jsonl`,
          'utf-8',
        )
        const lines = commentsBytes
          .trim()
          .split('\n')
          .filter((line) => line.trim() !== '')
        console.log(`  comments: ${String(lines.length)}`)
        for (const line of lines.slice(0, 3)) {
          try {
            const rec = JSON.parse(line) as { member_name?: string; text?: string }
            const author = rec.member_name ?? '?'
            const text = (rec.text ?? '').slice(0, 80)
            console.log(`  [${author}] ${text}`)
          } catch {
            console.log(`  (unparseable: ${line.slice(0, 80)})`)
          }
        }

        console.log(`\n--- exists via fs.promises.stat() ---`)
        console.log(`  exists: ${String(await exists(`${cardPath}/card.json`))}`)
        console.log(`  nonexistent: ${String(await exists('/trello/nope'))}`)
      }
    }

    console.log('\n--- bash history ---')
    const history = await fs.promises.readFile('/.bash_history', 'utf-8')
    const histLines = history.split('\n').filter((line) => line.trim() !== '')
    for (let i = 0; i < Math.min(6, histLines.length); i++) {
      console.log(`  ${histLines[i]!.slice(0, 120)}`)
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
