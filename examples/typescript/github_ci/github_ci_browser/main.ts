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
import { GitHubCIResource, MountMode, Workspace } from '@struktoai/mirage-browser'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function buildConfig(): { token: string; owner: string; repo: string } {
  const token = process.env.GITHUB_TOKEN
  if (token === undefined || token === '') throw new Error('GITHUB_TOKEN env var is required')
  const owner = process.env.GITHUB_OWNER ?? 'strukto-ai'
  const repo = process.env.GITHUB_REPO ?? 'mirage'
  return { token, owner, repo }
}

async function run(ws: Workspace, cmd: string): Promise<string> {
  console.log(`$ ${cmd}`)
  const r = await ws.execute(cmd)
  if (r.exitCode !== 0 && r.stderrText !== '') {
    console.log(`  STDERR: ${r.stderrText.slice(0, 200)}`)
  }
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') {
    for (const line of out.split('\n').slice(0, 12)) console.log(`  ${line.slice(0, 200)}`)
  }
  return out
}

async function main(): Promise<void> {
  const cfg = buildConfig()
  console.log(`Loading ${cfg.owner}/${cfg.repo} CI via @struktoai/mirage-browser …`)
  const resource = new GitHubCIResource(cfg)
  const ws = new Workspace({ '/ci': resource }, { mode: MountMode.READ })
  try {
    console.log('=== BROWSER MODE: GitHubCIResource → api.github.com (direct, CORS) ===\n')

    await run(ws, 'ls /ci/')

    console.log('')
    await run(ws, 'ls /ci/workflows/')

    console.log('')
    const runsOut = await run(ws, 'ls /ci/runs/')
    const firstRun = runsOut.split('\n')[0]
    if (firstRun !== undefined && firstRun !== '') {
      const runPath = `/ci/runs/${firstRun}`
      console.log('')
      await run(ws, `ls "${runPath}/"`)

      console.log('')
      await run(ws, `head -n 10 "${runPath}/run.json"`)
    }

    console.log('')
    await run(ws, 'tree -L 2 /ci/')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
