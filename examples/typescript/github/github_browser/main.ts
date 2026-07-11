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
import { GitHubResource, MountMode, Workspace } from '@struktoai/mirage-browser'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function buildConfig(): { token: string; owner: string; repo: string; ref?: string } {
  const token = process.env.GITHUB_TOKEN
  if (token === undefined || token === '') throw new Error('GITHUB_TOKEN env var is required')
  const owner = process.env.GITHUB_OWNER ?? 'strukto-ai'
  const repo = process.env.GITHUB_REPO ?? 'mirage'
  const ref = process.env.GITHUB_REF ?? 'main'
  return { token, owner, repo, ref }
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
  console.log(`Loading ${cfg.owner}/${cfg.repo} via @struktoai/mirage-browser …`)
  const resource = await GitHubResource.create(cfg)
  const ws = new Workspace({ '/github': resource }, { mode: MountMode.READ })
  try {
    console.log('=== BROWSER MODE: GitHubResource → api.github.com (direct, CORS) ===\n')

    await run(ws, 'ls /github/')

    console.log('')
    await run(ws, 'ls /github/python/mirage')

    console.log('')
    await run(ws, 'head -n 5 /github/python/pyproject.toml')

    console.log('')
    await run(ws, "grep 'BaseResource' /github/python/mirage/resource/base.py")

    console.log('')
    await run(ws, 'wc -l /github/python/mirage/types.py')

    console.log('')
    await run(ws, 'tree -L 2 /github/python/mirage/')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
