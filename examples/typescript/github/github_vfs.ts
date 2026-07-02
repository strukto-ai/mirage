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
import { GitHubResource, MountMode, patchNodeFs, Workspace, type GitHubConfig } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): GitHubConfig {
  const token = process.env.GITHUB_TOKEN
  if (token === undefined || token === '') throw new Error('GITHUB_TOKEN env var is required')
  const owner = process.env.GITHUB_OWNER ?? 'strukto-ai'
  const repo = process.env.GITHUB_REPO ?? 'mirage-internal'
  const ref = process.env.GITHUB_REF ?? 'main'
  return { token, owner, repo, ref }
}

async function main(): Promise<void> {
  const cfg = buildConfig()
  const resource = await GitHubResource.create(cfg)
  const ws = new Workspace({ '/github/': resource }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from GitHub transparently ===\n')

    console.log('--- fs.readdir() root ---')
    const entries = await fs.promises.readdir('/github')
    for (const e of entries.slice(0, 10)) console.log(`  ${e}`)
    if (entries.length > 10) console.log(`  ... (${String(entries.length)} total)`)

    console.log('\n--- fs.readdir() python/mirage/ ---')
    const core = await fs.promises.readdir('/github/python/mirage')
    for (const c of core.slice(0, 10)) console.log(`  ${c}`)

    console.log('\n--- fs.readdir() python/mirage/core/ ---')
    const coreDirs = await fs.promises.readdir('/github/python/mirage/core')
    for (const d of coreDirs.slice(0, 10)) console.log(`  ${d}`)
    if (coreDirs.length > 10) console.log(`  ... (${String(coreDirs.length)} total)`)

    console.log('\n--- open() + read pyproject.toml (first 5 lines) ---')
    const proj = await fs.promises.readFile('/github/python/pyproject.toml', 'utf-8')
    for (const line of proj.split('\n').slice(0, 5)) console.log(`  ${line}`)

    console.log('\n--- open() + read python/mirage/types.py (first 5 lines) ---')
    const types = await fs.promises.readFile('/github/python/mirage/types.py', 'utf-8')
    for (const line of types.split('\n').slice(0, 5)) console.log(`  ${line}`)

    console.log('\n--- fs.promises.stat().isDirectory() checks ---')
    const coreStat = await fs.promises.stat('/github/python/mirage/core')
    console.log(`  /github/python/mirage/core: ${String(coreStat.isDirectory())}`)
    const projStat = await fs.promises.stat('/github/python/pyproject.toml')
    console.log(`  /github/python/pyproject.toml: ${String(projStat.isDirectory())}`)

    console.log('\n--- fs.promises.stat().isFile() checks ---')
    console.log(`  /github/python/pyproject.toml: ${String(projStat.isFile())}`)
    console.log(`  /github/python/mirage/core: ${String(coreStat.isFile())}`)

    const records = ws.records
    const total = records.reduce((s, r) => s + (r.bytes ?? 0), 0)
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
