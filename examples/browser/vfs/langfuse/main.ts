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
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { LangfuseVFS, MountMode, Workspace } from '@struktoai/mirage-browser'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

interface LangfuseCtorConfig {
  publicKey: string
  secretKey: string
  host?: string
  defaultTraceLimit?: number
  defaultFromTimestamp?: string
}

function buildConfig(): LangfuseCtorConfig {
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
  const cfg: LangfuseCtorConfig = {
    publicKey,
    secretKey,
    defaultTraceLimit: 10,
    defaultFromTimestamp: sevenDaysAgo,
  }
  if (host !== undefined && host !== '') cfg.host = host
  return cfg
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
  const lf = new LangfuseVFS(buildConfig())
  const ws = new Workspace({ '/langfuse': lf }, { mode: MountMode.READ })
  try {
    console.log('=== BROWSER MODE: LangfuseVFS → cloud.langfuse.com (direct REST + CORS) ===\n')

    await run(ws, 'ls /langfuse/')

    console.log('')
    await run(ws, 'ls /langfuse/datasets/')

    console.log('')
    const d0 = (await run(ws, 'ls /langfuse/datasets/ | head -n 1')).trim()
    if (d0 === '') return
    const dPath = `/langfuse/datasets/${d0}`

    console.log('')
    await run(ws, `ls ${dPath}`)

    console.log('')
    await run(ws, `wc -l ${dPath}/items.jsonl`)

    console.log('')
    await run(ws, `head -n 2 ${dPath}/items.jsonl`)

    console.log('')
    await run(ws, 'ls /langfuse/prompts/')

    console.log('')
    const p0 = (await run(ws, 'ls /langfuse/prompts/ | head -n 1')).trim()
    if (p0 !== '') {
      console.log('')
      await run(ws, `tree /langfuse/prompts/${p0}`)
    }

    console.log('\n>>> Browser-style workspace at /langfuse (sandboxed — not visible to host fs)')
    console.log('>>> Press Enter to exit...')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question('')
    rl.close()
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
