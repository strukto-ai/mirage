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
import { MountMode, TrelloVFS, Workspace } from '@struktoai/mirage-browser'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function buildConfig(): { apiKey: string; apiToken: string } {
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
  const r = await ws.shell(cmd)
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
  const trello = new TrelloVFS(buildConfig())
  const ws = new Workspace({ '/trello': trello }, { mode: MountMode.READ })
  try {
    console.log('=== BROWSER MODE: TrelloVFS → api.trello.com (direct, CORS) ===\n')

    await run(ws, 'ls /trello/')

    console.log('')
    const ws0 = (await run(ws, 'ls /trello/workspaces/ | head -n 1')).trim()
    if (ws0 === '') {
      console.log('no workspaces')
      return
    }
    const wsBase = `/trello/workspaces/${ws0}`

    console.log('')
    await run(ws, `cat "${wsBase}/workspace.json"`)

    console.log('')
    await run(ws, `tree -L 3 "${wsBase}"`)

    console.log('')
    const b0 = (await run(ws, `ls "${wsBase}/boards/" | head -n 1`)).trim()
    if (b0 === '') return
    const boardBase = `${wsBase}/boards/${b0}`

    console.log('')
    await run(ws, `cat "${boardBase}/board.json"`)

    console.log('')
    await run(ws, `jq -r ".board_name" "${boardBase}/board.json"`)

    console.log('')
    await run(ws, `ls "${boardBase}/labels/"`)

    console.log('')
    await run(ws, `find "${boardBase}" -name "card.json" | head -n 5`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
