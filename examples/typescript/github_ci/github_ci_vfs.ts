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
  GitHubCIResource,
  MountMode,
  patchNodeFs,
  Workspace,
  type GitHubCIConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): GitHubCIConfig {
  const token = process.env.GITHUB_TOKEN
  if (token === undefined || token === '') throw new Error('GITHUB_TOKEN env var is required')
  const owner = process.env.GITHUB_OWNER ?? 'strukto-ai'
  const repo = process.env.GITHUB_REPO ?? 'mirage'
  return { token, owner, repo, maxRuns: 300 }
}

async function main(): Promise<void> {
  const resource = new GitHubCIResource(buildConfig())
  const ws = new Workspace({ '/ci/': resource }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from GitHub CI transparently ===\n')

    console.log('--- fs.readdir() root ---')
    const entries = await fs.promises.readdir('/ci')
    for (const e of entries) console.log(`  ${e}`)

    console.log('\n--- fs.readdir() workflows ---')
    const workflows = await fs.promises.readdir('/ci/workflows')
    for (const wf of workflows.slice(0, 10)) console.log(`  ${wf}`)

    if (workflows.length > 0) {
      const wfPath = `/ci/workflows/${workflows[0]!}`
      console.log(`\n--- open() + read ${wfPath} ---`)
      const wfData = JSON.parse(await fs.promises.readFile(wfPath, 'utf-8')) as Record<string, unknown>
      console.log(`  name: ${String(wfData['name'])}`)
      console.log(`  path: ${String(wfData['path'])}`)
      console.log(`  state: ${String(wfData['state'])}`)
    }

    console.log('\n--- fs.readdir() runs ---')
    const runs = await fs.promises.readdir('/ci/runs')
    for (const r of runs.slice(0, 5)) console.log(`  ${r}`)
    if (runs.length > 5) console.log(`  ... (${String(runs.length)} total)`)

    if (runs.length > 0) {
      const runDir = `/ci/runs/${runs[0]!}`
      console.log(`\n--- fs.readdir() ${runDir} ---`)
      const contents = await fs.promises.readdir(runDir)
      for (const c of contents) console.log(`  ${c}`)

      const runJsonName = contents.find((c) => c === 'run.json')
      if (runJsonName !== undefined) {
        console.log('\n--- open() + read run.json ---')
        const data = JSON.parse(
          await fs.promises.readFile(`${runDir}/run.json`, 'utf-8'),
        ) as Record<string, unknown>
        console.log(`  status: ${String(data['status'])}`)
        console.log(`  conclusion: ${String(data['conclusion'])}`)
        console.log(`  event: ${String(data['event'])}`)
        console.log(`  branch: ${String(data['head_branch'])}`)
      }

      const jobsName = contents.find((c) => c === 'jobs')
      if (jobsName !== undefined) {
        const jobsDir = `${runDir}/jobs`
        console.log('\n--- fs.readdir() jobs ---')
        const jobs = await fs.promises.readdir(jobsDir)
        for (const j of jobs.slice(0, 10)) console.log(`  ${j}`)

        const jsonJobs = jobs.filter((j) => j.endsWith('.json'))
        const logJobs = jobs.filter((j) => j.endsWith('.log'))

        if (jsonJobs[0] !== undefined) {
          console.log('\n--- open() + read job .json ---')
          const data = JSON.parse(
            await fs.promises.readFile(`${jobsDir}/${jsonJobs[0]}`, 'utf-8'),
          ) as Record<string, unknown>
          console.log(`  name: ${String(data['name'])}`)
          console.log(`  status: ${String(data['status'])}`)
          console.log(`  conclusion: ${String(data['conclusion'])}`)
          const steps = (data['steps'] ?? []) as Array<Record<string, unknown>>
          console.log(`  steps: ${String(steps.length)}`)
          for (const s of steps.slice(0, 3)) {
            console.log(
              `    ${String(s['number'])}. ${String(s['name'])} -> ${String(s['conclusion'])}`,
            )
          }
        }

        if (logJobs[0] !== undefined) {
          console.log('\n--- open() + read job .log (first 10 lines) ---')
          const text = await fs.promises.readFile(`${jobsDir}/${logJobs[0]}`, 'utf-8')
          const lines = text.split('\n')
          for (const line of lines.slice(0, 10)) console.log(`  ${line.slice(0, 120)}`)
          if (lines.length > 10) console.log('  ...')
        }
      }
    }

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
