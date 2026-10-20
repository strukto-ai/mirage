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
import { LangfuseVFS, MountMode, Workspace, type FileStat, type LangfuseConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} env var is required`)
  return value
}

function buildConfig(): LangfuseConfig {
  return {
    publicKey: requireEnv('LANGFUSE_PUBLIC_KEY'),
    secretKey: requireEnv('LANGFUSE_SECRET_KEY'),
    host: requireEnv('LANGFUSE_HOST'),
    defaultTraceLimit: 20,
  }
}

async function run(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n>>> ${cmd}`)
  const r = await ws.shell(cmd)
  const out = r.stdoutText.trim()
  const err = r.stderrText
  if (out !== '') {
    const lines = out.split('\n')
    for (const line of lines.slice(0, 10)) console.log(`  ${line.slice(0, 120)}`)
    if (lines.length > 10) console.log(`  ... (${String(lines.length)} lines total)`)
  }
  if (err !== '') console.log(`  [stderr] ${err.trim().slice(0, 120)}`)
  if (out === '' && err === '') console.log(`  (empty, exit=${String(r.exitCode)})`)
}

async function listing(ws: Workspace, cmd: string): Promise<string[]> {
  const out = (await ws.shell(cmd)).stdoutText.trim()
  return out.split('\n').filter((line) => line.trim() !== '')
}

async function timed(ws: Workspace, cmd: string): Promise<[number, string]> {
  const start = performance.now()
  const out = (await ws.shell(cmd)).stdoutText
  return [performance.now() - start, out]
}

function banner(title: string, lead = '\n'): void {
  console.log(lead + '='.repeat(60))
  console.log(title)
  console.log('='.repeat(60))
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/langfuse': new LangfuseVFS(buildConfig()) }, { mode: MountMode.READ })
  try {
    console.log('=== not-found errors show the full virtual path ===')
    for (const cmd of [
      'cat /langfuse/__nf_missing__.txt',
      'head /langfuse/__nf_missing__.txt',
      'stat /langfuse/__nf_missing__.txt',
    ]) {
      const result = await ws.shell(cmd)
      console.log(`$ ${cmd}`)
      console.log(`  exit=${String(result.exitCode)}  ${result.stderrText.trim()}`)
    }

    banner('LS across all directories', '')

    await run(ws, 'ls /langfuse/')
    await run(ws, 'ls /langfuse/traces/')
    await run(ws, 'ls /langfuse/sessions/')
    await run(ws, 'ls /langfuse/prompts/')
    await run(ws, 'ls /langfuse/datasets/')

    banner('CAT across different resource types')

    const traceFiles = await listing(ws, 'ls /langfuse/traces/')
    const tp = traceFiles.length > 0 ? `/langfuse/traces/${traceFiles[0].trim()}` : null
    if (tp !== null) await run(ws, `cat "${tp}" | head -n 5`)
    else console.log('  no traces found, skipping cat trace')

    await run(ws, 'cat "/langfuse/prompts/summarize/1.json"')
    await run(ws, 'cat "/langfuse/datasets/qa-eval/items.jsonl"')

    banner('GREP across different scopes')

    await run(ws, 'grep -r "chat" "/langfuse/traces/"')
    await run(ws, 'grep -r "support" "/langfuse/traces/"')
    await run(ws, 'grep -r "chat-session" "/langfuse/sessions/"')
    await run(ws, 'grep -r "summarize" "/langfuse/prompts/"')
    await run(ws, 'grep -r "qa" "/langfuse/datasets/"')
    if (tp !== null) await run(ws, `grep "name" "${tp}"`)

    banner('JQ across different resource types')

    if (tp !== null) {
      await run(ws, `jq ".name" "${tp}"`)
      await run(ws, `jq ".session_id" "${tp}"`)
      await run(ws, `jq ".input" "${tp}"`)
    }
    await run(ws, 'jq ".prompt" "/langfuse/prompts/summarize/1.json"')
    await run(ws, 'jq ".config" "/langfuse/prompts/classify/1.json"')
    await run(ws, 'jq ".input" "/langfuse/datasets/qa-eval/items.jsonl"')
    await run(ws, 'jq -r ".expected_output.answer" "/langfuse/datasets/qa-eval/items.jsonl"')

    banner('SESSION browsing')

    await run(ws, 'ls /langfuse/sessions/chat-session-001/')
    const sessionTraces = await listing(ws, 'ls /langfuse/sessions/chat-session-001/')
    if (sessionTraces.length > 0) {
      const sp = `/langfuse/sessions/chat-session-001/${sessionTraces[0].trim()}`
      await run(ws, `cat "${sp}" | head -n 3`)
    }

    banner('PROMPTS and DATASETS detail')

    await run(ws, 'ls /langfuse/prompts/summarize/')
    await run(ws, 'ls /langfuse/datasets/qa-eval/')
    await run(ws, 'ls /langfuse/datasets/qa-eval/runs/')

    await run(ws, 'stat "/langfuse/prompts/summarize"')
    await run(ws, 'stat "/langfuse/datasets/qa-eval"')

    // chmod/chown/touch never hit the Langfuse API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log('=== metadata overlay on /langfuse/prompts/summarize ===')
    const metaRes = await ws.shell(
      'chmod 640 "/langfuse/prompts/summarize"' +
        ' && chown 500:dev "/langfuse/prompts/summarize"' +
        ' && touch -t 202601021530 "/langfuse/prompts/summarize"',
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', '/langfuse/prompts/summarize')) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    banner('TREE, FIND, NAVIGATION')

    await run(ws, 'tree -L 2 /langfuse/')
    await run(ws, 'find "/langfuse/prompts/" -name "*.json"')
    // -path matches the display path; -size counts dirs and sizeless
    // rendered files as 0 (so +0c drops them, -1k keeps them).
    await run(ws, 'find "/langfuse/" -maxdepth 1 -path "*prompts*"')
    await run(ws, 'find "/langfuse/" -maxdepth 1 -size +0c')
    await run(ws, 'find "/langfuse/" -maxdepth 1 -size -1k')

    await ws.shell('cd "/langfuse/prompts"')
    await run(ws, 'pwd')
    await run(ws, 'ls')

    banner('CACHING: warm reads served from cache (no backend fetch)')
    const promptFiles = await listing(ws, 'find "/langfuse/prompts/" -name "*.json"')
    if (promptFiles.length > 0) {
      const cacheFile = promptFiles[0].trim()
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

    banner('GLOB: mid-path patterns walk segment by segment')
    const globR = await ws.shell('echo /langfuse/prom*/*')
    const globOut = globR.stdoutText.trim()
    console.log(`  echo /langfuse/prom*/* -> ${globOut.slice(0, 200)}`)
    if (!globOut.includes('/langfuse/prompts/')) throw new Error('mid-path glob did not expand')

    // A glob that matches nothing stays the literal word, so the
    // command reports it like GNU coreutils.
    const litR = await ws.shell('cat /langfuse/zz-none-*/x.json')
    const litErr = litR.stderrText.trim()
    console.log(
      `  cat /langfuse/zz-none-*/x.json -> exit=${String(litR.exitCode)} ${litErr.slice(0, 120)}`,
    )
    if (litR.exitCode !== 1 || !litErr.includes('zz-none-*')) {
      throw new Error('zero-match glob did not keep the literal')
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
