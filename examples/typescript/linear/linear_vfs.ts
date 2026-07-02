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
  LinearResource,
  MountMode,
  patchNodeFs,
  Workspace,
  type LinearConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): LinearConfig {
  const apiKey = process.env.LINEAR_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error('LINEAR_API_KEY env var is required')
  }
  return { apiKey }
}

async function main(): Promise<void> {
  const resource = new LinearResource(buildConfig())
  const ws = new Workspace({ '/linear': resource }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from Linear transparently ===\n')

    console.log('--- fs.readdir() /linear ---')
    for (const r of await fs.promises.readdir('/linear')) console.log(`  ${r}`)

    console.log('\n--- fs.readdir() /linear/teams ---')
    const teams = await fs.promises.readdir('/linear/teams')
    for (const t of teams.slice(0, 5)) console.log(`  ${t}`)

    if (teams.length === 0) {
      console.log('  (no teams)')
      return
    }
    const t0 = teams[0]!
    const teamBase = `/linear/teams/${t0}`

    console.log(`\n--- fs.readdir() ${t0} ---`)
    for (const c of await fs.promises.readdir(teamBase)) console.log(`  ${c}`)

    console.log(`\n--- fs.readFile() ${t0}/team.json ---`)
    const teamBytes = await fs.promises.readFile(`${teamBase}/team.json`, 'utf-8')
    console.log(`  ${teamBytes.trim().slice(0, 250)}`)

    console.log(`\n--- fs.readdir() ${t0}/issues ---`)
    const issues = await fs.promises.readdir(`${teamBase}/issues`)
    for (const i of issues.slice(0, 5)) console.log(`  ${i}`)

    if (issues.length > 0) {
      const i0 = issues[0]!
      const issuePath = `${teamBase}/issues/${i0}`

      console.log(`\n--- fs.readFile() ${i0}/issue.json ---`)
      const issueBytes = await fs.promises.readFile(`${issuePath}/issue.json`, 'utf-8')
      console.log(`  ${issueBytes.trim().slice(0, 400)}`)

      console.log(`\n--- fs.readFile() ${i0}/comments.jsonl ---`)
      const cmtBytes = await fs.promises.readFile(`${issuePath}/comments.jsonl`, 'utf-8')
      const lines = cmtBytes
        .trim()
        .split('\n')
        .filter((line) => line.trim() !== '')
      console.log(`  comments: ${String(lines.length)}`)
      for (const line of lines.slice(0, 3)) {
        try {
          const rec = JSON.parse(line) as { user_name?: string; body?: string }
          const author = rec.user_name ?? '?'
          const body = (rec.body ?? '').slice(0, 80)
          console.log(`  [${author}] ${body}`)
        } catch {
          console.log(`  (unparseable: ${line.slice(0, 80)})`)
        }
      }
    }

    console.log(`\n--- fs.readdir() ${t0}/projects ---`)
    const projects = await fs.promises.readdir(`${teamBase}/projects`)
    for (const p of projects.slice(0, 5)) console.log(`  ${p}`)

    console.log('\n--- bash history ---')
    const history = await fs.promises.readFile('/.bash_history', 'utf-8')
    const histLines = history.split('\n').filter((line) => line.trim() !== '')
    for (let i = 0; i < Math.min(6, histLines.length); i++) {
      console.log(`  ${histLines[i]!.slice(0, 120)}`)
    }

    const records = ws.records
    const total = records.reduce((acc, r) => acc + (r.bytes ?? 0), 0)
    console.log(`\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
