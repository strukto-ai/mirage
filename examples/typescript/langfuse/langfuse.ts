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
import { LangfuseResource, MountMode, Workspace, type LangfuseConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): LangfuseConfig {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? ''
  const secretKey = process.env.LANGFUSE_SECRET_KEY ?? ''
  if (publicKey === '' || secretKey === '') {
    throw new Error('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY env vars are required')
  }
  const host = process.env.LANGFUSE_HOST ?? ''
  return { publicKey, secretKey, ...(host !== '' ? { host } : {}) }
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

async function timed(ws: Workspace, cmd: string): Promise<[number, string]> {
  const start = performance.now()
  const out = (await ws.execute(cmd)).stdoutText
  return [performance.now() - start, out]
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/langfuse': new LangfuseResource(buildConfig()) },
    { mode: MountMode.READ },
  )
  try {
    console.log('=== ls /langfuse/ ===')
    await run(ws, 'ls /langfuse/')
    for (const scope of ['traces', 'sessions', 'prompts', 'datasets']) {
      console.log(`\n=== ls /langfuse/${scope}/ ===`)
      await run(ws, `ls /langfuse/${scope}/ | head -n 5`)
    }

    console.log('\n=== first trace ===')
    const t0 = (await run(ws, 'ls /langfuse/traces/ | head -n 1')).trim()
    if (t0 !== '') {
      const tracePath = `/langfuse/traces/${t0}`
      await run(ws, `cat "${tracePath}" | head -n 5`)
      await run(ws, `jq ".name" "${tracePath}"`)
      await run(ws, `jq -r ".id" "${tracePath}"`)
      await run(ws, `wc "${tracePath}"`)
      await run(ws, `stat "${tracePath}"`)
    }

    console.log('\n=== grep scope pushdown ===')
    await run(ws, 'grep "a" /langfuse/traces/ | head -n 3')
    await run(ws, 'grep "a" /langfuse/sessions/ | head -n 3')
    await run(ws, 'grep "a" /langfuse/prompts/ | head -n 3')

    console.log('\n=== rg across prompts ===')
    await run(ws, 'rg -l "name" /langfuse/prompts/ | head -n 3')

    console.log('\n=== datasets ===')
    const d0 = (await run(ws, 'ls /langfuse/datasets/ | head -n 1')).trim().replace(/\/+$/, '')
    if (d0 !== '') {
      const itemsPath = `/langfuse/datasets/${d0}/items.jsonl`
      await run(ws, `head -n 2 "${itemsPath}"`)
      await run(ws, `jq ".[].id" "${itemsPath}" | head -n 3`)
    }

    console.log('\n=== tree -L 2 /langfuse/ ===')
    await run(ws, 'tree -L 2 /langfuse/ | head -n 20')

    console.log('\n' + '='.repeat(60))
    console.log('CACHING: warm reads served from cache (no backend fetch)')
    console.log('='.repeat(60))
    const found = await run(ws, 'find "/langfuse/prompts/" -name "*.json"')
    const promptFiles = found === '' ? [] : found.split('\n')
    if (promptFiles.length > 0) {
      const cacheFile = (promptFiles[0] ?? '').trim()
      const [coldMs, body] = await timed(ws, `cat "${cacheFile}"`)
      const [warmMs] = await timed(ws, `cat "${cacheFile}"`)
      const [grepMs] = await timed(ws, `grep . "${cacheFile}"`)
      const [headMs] = await timed(ws, `head -n 1 "${cacheFile}"`)
      const [tailMs] = await timed(ws, `tail -n 1 "${cacheFile}"`)
      const [wcMs] = await timed(ws, `wc -l "${cacheFile}"`)
      console.log(`  file=${cacheFile} size=${String(body.length)}B`)
      console.log(
        `  cold cat=${coldMs.toFixed(0)}ms  warm cat=${warmMs.toFixed(0)}ms  ` +
          `grep=${grepMs.toFixed(0)}ms head=${headMs.toFixed(0)}ms tail=${tailMs.toFixed(0)}ms ` +
          `wc=${wcMs.toFixed(0)}ms`,
      )
      console.log(
        `  served_from_cache=${String(warmMs < coldMs / 5)} ` +
          `(warm speedup ${(coldMs / Math.max(warmMs, 0.001)).toFixed(0)}x)`,
      )
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
