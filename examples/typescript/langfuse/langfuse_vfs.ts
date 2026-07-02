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
  LangfuseResource,
  MountMode,
  patchNodeFs,
  Workspace,
  type LangfuseConfig,
} from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): LangfuseConfig {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  const host = process.env.LANGFUSE_HOST
  if (publicKey === undefined || publicKey === '') {
    throw new Error('LANGFUSE_PUBLIC_KEY env var is required')
  }
  if (secretKey === undefined || secretKey === '') {
    throw new Error('LANGFUSE_SECRET_KEY env var is required')
  }
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const cfg: LangfuseConfig = {
    publicKey,
    secretKey,
    defaultTraceLimit: 10,
    defaultFromTimestamp: sevenDaysAgo,
  }
  if (host !== undefined && host !== '') cfg.host = host
  return cfg
}

async function main(): Promise<void> {
  const MOUNT = '/langfuse'
  const resource = new LangfuseResource(buildConfig())
  const ws = new Workspace({ [MOUNT]: resource }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log(`=== VFS MODE: mounted at ${MOUNT} (in-process fs patch) ===\n`)

    console.log('--- fs.readdir() /langfuse ---')
    for (const r of await fs.promises.readdir('/langfuse')) console.log(`  ${r}`)

    console.log('\n--- fs.readdir() /langfuse/traces ---')
    const traces = await fs.promises.readdir('/langfuse/traces')
    for (const t of traces.slice(0, 5)) console.log(`  ${t}`)
    if (traces.length > 5) console.log(`  ... (${String(traces.length)} total)`)

    if (traces.length > 0) {
      const t0 = traces[0]!
      console.log(`\n--- fs.readFile() ${t0} ---`)
      const traceBytes = await fs.promises.readFile(t0, 'utf-8')
      try {
        const doc = JSON.parse(traceBytes) as Record<string, unknown>
        console.log(`  name: ${String(doc.name ?? '?')}`)
        console.log(`  id: ${String(doc.id ?? '?')}`)
        const sid = doc.sessionId ?? doc.session_id ?? '?'
        console.log(`  session_id: ${String(sid)}`)
      } catch {
        for (const line of traceBytes.split('\n').slice(0, 5)) {
          console.log(`  ${line.slice(0, 120)}`)
        }
      }
    }

    console.log('\n--- fs.readdir() /langfuse/sessions ---')
    const sessions = await fs.promises.readdir('/langfuse/sessions')
    for (const s of sessions.slice(0, 5)) console.log(`  ${s}`)
    if (sessions.length > 5) console.log(`  ... (${String(sessions.length)} total)`)

    console.log('\n--- fs.readdir() /langfuse/prompts ---')
    const prompts = await fs.promises.readdir('/langfuse/prompts')
    for (const p of prompts.slice(0, 5)) console.log(`  ${p}`)
    if (prompts.length > 5) console.log(`  ... (${String(prompts.length)} total)`)

    console.log('\n--- fs.readdir() /langfuse/datasets ---')
    const datasets = await fs.promises.readdir('/langfuse/datasets')
    for (const d of datasets) console.log(`  ${d}`)

    if (datasets.length > 0) {
      const d0 = datasets[0]!
      const dPath = `/langfuse/datasets/${d0}`
      console.log(`\n--- fs.readdir() ${dPath} ---`)
      for (const item of await fs.promises.readdir(dPath)) console.log(`  ${item}`)

      console.log(`\n--- fs.readFile() ${dPath}/items.jsonl (first 3 lines) ---`)
      const itemsBytes = await fs.promises.readFile(`${dPath}/items.jsonl`, 'utf-8')
      const lines = itemsBytes.split('\n').filter((line) => line.trim() !== '')
      for (const line of lines.slice(0, 3)) console.log(`  ${line.slice(0, 160)}`)
      console.log(`  total items: ${String(lines.length)}`)
    }

    if (prompts.length > 0) {
      const p0 = prompts[0]!
      const pPath = `/langfuse/prompts/${p0}`
      console.log(`\n--- fs.readdir() ${pPath} ---`)
      const versions = await fs.promises.readdir(pPath)
      for (const v of versions) console.log(`  ${v}`)
      if (versions.length > 0) {
        const v0 = versions[0]!
        console.log(`\n--- fs.readFile() ${pPath}/${v0} ---`)
        const promptBytes = await fs.promises.readFile(`${pPath}/${v0}`, 'utf-8')
        try {
          const doc = JSON.parse(promptBytes) as Record<string, unknown>
          console.log(`  name: ${String(doc.name ?? '?')}`)
          console.log(`  version: ${String(doc.version ?? '?')}`)
          const prompt = doc.prompt
          const summary = typeof prompt === 'string' ? prompt.slice(0, 120) : JSON.stringify(prompt).slice(0, 120)
          console.log(`  prompt: ${summary}`)
        } catch {
          console.log(`  ${promptBytes.slice(0, 200)}`)
        }
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
