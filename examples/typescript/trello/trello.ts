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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { MountMode, TrelloResource, Workspace, type TrelloConfig } from '@struktoai/mirage-node'

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
  return { apiKey, apiToken }
}

async function run(ws: Workspace, cmd: string): Promise<string> {
  console.log(`$ ${cmd}`)
  const r = await ws.execute(cmd)
  if (r.exitCode !== 0 && r.stderrText !== '') {
    console.log(`  STDERR: ${r.stderrText.slice(0, 200)}`)
  }
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') {
    for (const line of out.split('\n').slice(0, 10)) console.log(`  ${line.slice(0, 200)}`)
  }
  return out
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/trello': new TrelloResource(buildConfig()) },
    { mode: MountMode.WRITE },
  )
  try {
    console.log('=== ls /trello/ ===')
    await run(ws, 'ls /trello/')

    console.log('\n=== ls /trello/workspaces/ ===')
    const ws0 = (await run(ws, 'ls /trello/workspaces/ | head -n 1')).trim()
    if (ws0 === '') {
      console.log('no workspaces')
      return
    }
    const wsBase = `/trello/workspaces/${ws0}`

    console.log(`\n=== tree -L 3 ${wsBase} ===`)
    await run(ws, `tree -L 3 "${wsBase}"`)

    console.log(`\n=== cat ${wsBase}/workspace.json ===`)
    await run(ws, `cat "${wsBase}/workspace.json"`)

    // ── glob expansion: the workspace segment is the pattern, the
    // literal tail keeps walking (lists workspaces once, then filters).
    console.log('\n=== echo /trello/workspaces/*/boards (mid-path glob) ===')
    const globR = await ws.execute('echo /trello/workspaces/*/boards')
    const globOut = globR.stdoutText.trim()
    console.log(`  ${globOut.slice(0, 200)}`)
    if (!globOut.endsWith('/boards')) {
      throw new Error('regression: mid-path glob did not expand')
    }

    // A glob that matches nothing stays the literal word, so the
    // command reports it like GNU coreutils.
    console.log('\n=== cat /trello/workspaces/zz-none-*/workspace.json (no match) ===')
    const litR = await ws.execute('cat /trello/workspaces/zz-none-*/workspace.json')
    const litErr = litR.stderrText.trim()
    console.log(`  exit=${litR.exitCode}  ${litErr.slice(0, 120)}`)
    if (litR.exitCode !== 1 || !litErr.includes('zz-none-*')) {
      throw new Error('regression: zero-match glob did not keep the literal')
    }

    console.log(`\n=== ls ${wsBase}/boards/ ===`)
    const b0 = (await run(ws, `ls "${wsBase}/boards/" | head -n 1`)).trim()
    if (b0 === '') return
    const boardBase = `${wsBase}/boards/${b0}`

    console.log(`\n=== cat ${b0}/board.json ===`)
    await run(ws, `cat "${boardBase}/board.json"`)

    console.log(`\n=== jq -r '.board_name' board.json ===`)
    await run(ws, `jq -r ".board_name" "${boardBase}/board.json"`)

    console.log(`\n=== ls ${b0}/labels/ ===`)
    await run(ws, `ls "${boardBase}/labels/"`)

    console.log(`\n=== ls ${b0}/lists/ ===`)
    const l0 = (await run(ws, `ls "${boardBase}/lists/" | head -n 1`)).trim()
    if (l0 === '') return

    console.log(`\n=== ls ${l0}/cards/ ===`)
    await run(ws, `ls "${boardBase}/lists/${l0}/cards/"`)

    console.log(`\n=== find ${boardBase} -name "card.json" ===`)
    await run(ws, `find "${boardBase}" -name "card.json"`)

    console.log(`\n=== find ${boardBase} -type d | head -n 5 ===`)
    await run(ws, `find "${boardBase}" -type d | head -n 5`)

    console.log(`\n=== du -s ${boardBase} (walk fallback) ===`)
    await run(ws, `du -s "${boardBase}"`)

    console.log(`\n=== grep -l hello ${boardBase} ===`)
    await run(ws, `grep -r -l hello "${boardBase}"`)

    console.log(`\n=== wc -l first card.json ===`)
    const card = (await run(ws, `find "${boardBase}" -name "card.json" | head -n 1`)).trim()
    if (card !== '') {
      await run(ws, `wc -l "${card}"`)
    }

    console.log('\n=== card write commands (sandbox card) ===')
    const listId = l0.replace(/\/+$/, '').split('__').pop() ?? ''
    if (listId !== '') {
      const created = await run(
        ws,
        `trello-card-create --list_id ${listId} --name "mirage example card" --desc "created by examples/typescript/trello/trello.ts"`,
      )
      let cardId = ''
      try {
        cardId = (JSON.parse(created) as { card_id?: string; id?: string }).card_id ?? ''
        if (cardId === '') cardId = (JSON.parse(created) as { id?: string }).id ?? ''
      } catch {
        console.log('  could not parse created card payload, skipping write demos')
      }
      if (cardId !== '') {
        await run(ws, `trello-card-update --card_id ${cardId} --name "mirage example card (updated)"`)
        await run(ws, `trello-card-move --card_id ${cardId} --list_id ${listId}`)
        const comment = await run(
          ws,
          `trello-card-comment-add --card_id ${cardId} --text "hello from mirage"`,
        )
        let commentId = ''
        try {
          commentId = (JSON.parse(comment) as { comment_id?: string; id?: string }).comment_id ?? ''
          if (commentId === '') commentId = (JSON.parse(comment) as { id?: string }).id ?? ''
        } catch {
          commentId = ''
        }
        if (commentId !== '') {
          await run(
            ws,
            `trello-card-comment-update --comment_id ${commentId} --card_id ${cardId} --text "updated comment"`,
          )
        }
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
