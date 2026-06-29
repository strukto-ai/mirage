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
import { LinearResource, MountMode, Workspace, type LinearConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): LinearConfig {
  const apiKey = process.env.LINEAR_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error('LINEAR_API_KEY env var is required')
  }
  return { apiKey }
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
    { '/linear': new LinearResource(buildConfig()) },
    { mode: MountMode.READ },
  )
  try {
    console.log('=== ls /linear/ ===')
    await run(ws, 'ls /linear/')

    console.log('\n=== ls /linear/teams/ ===')
    const t0 = (await run(ws, 'ls /linear/teams/ | head -n 1')).trim()
    if (t0 === '') {
      console.log('no teams')
      return
    }
    const teamBase = `/linear/teams/${t0}`

    console.log(`\n=== tree -L 2 ${teamBase} ===`)
    await run(ws, `tree -L 2 "${teamBase}"`)

    console.log(`\n=== cat ${teamBase}/team.json ===`)
    await run(ws, `cat "${teamBase}/team.json"`)

    console.log(`\n=== ls ${teamBase}/issues/ ===`)
    const i0 = (await run(ws, `ls "${teamBase}/issues/" | head -n 1`)).trim()
    if (i0 === '') return
    const issuePath = `${teamBase}/issues/${i0}`

    console.log(`\n=== cat ${i0}/issue.json ===`)
    await run(ws, `cat "${issuePath}/issue.json"`)

    console.log(`\n=== jq -r '.title' issue.json ===`)
    await run(ws, `jq -r ".title" "${issuePath}/issue.json"`)

    console.log(`\n=== jq -r '.state_name' issue.json ===`)
    await run(ws, `jq -r ".state_name" "${issuePath}/issue.json"`)

    console.log(`\n=== ls ${teamBase}/members/ ===`)
    await run(ws, `ls "${teamBase}/members/"`)

    console.log(`\n=== ls ${teamBase}/projects/ ===`)
    await run(ws, `ls "${teamBase}/projects/"`)

    console.log(`\n=== find ${teamBase} -name "issue.json" | head -n 5 ===`)
    await run(ws, `find "${teamBase}" -name "issue.json" | head -n 5`)

    console.log(`\n=== find ${teamBase} -type d | head -n 5 ===`)
    await run(ws, `find "${teamBase}" -type d | head -n 5`)

    console.log(`\n=== du -s ${teamBase} (walk fallback) ===`)
    await run(ws, `du -s "${teamBase}"`)

    console.log(`\n=== grep -r -l bug ${teamBase}/issues/ | head -n 3 ===`)
    await run(ws, `grep -r -l bug "${teamBase}/issues/" | head -n 3`)

    console.log(`\n=== stat ${i0}/issue.json ===`)
    await run(ws, `stat "${issuePath}/issue.json"`)

    console.log(`\n=== wc / tail issue.json ===`)
    await run(ws, `wc "${issuePath}/issue.json"`)
    await run(ws, `tail -n 3 "${issuePath}/issue.json"`)

    console.log(`\n=== rg -l title ${teamBase}/issues/ | head -n 3 ===`)
    await run(ws, `rg -l "title" "${teamBase}/issues/" | head -n 3`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
