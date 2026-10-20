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
import { DifyVFS, MountMode, Workspace, type FileStat } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

// Python's shlex.quote, so the printed commands match the Python example.
function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function buildVfs(): DifyVFS {
  return new DifyVFS({
    config: {
      apiKey: requireEnv('DIFY_API_KEY'),
      baseUrl: process.env.DIFY_BASE_URL ?? 'https://api.dify.ai/v1',
      datasetId: requireEnv('DIFY_DATASET_ID'),
      slugMetadataName: process.env.DIFY_SLUG_METADATA_NAME ?? 'slug',
    },
  })
}

async function run(ws: Workspace, command: string, maxChars = 800): Promise<string> {
  const result = await ws.shell(command)
  const stdout = result.stdoutText
  const stderr = result.stderrText
  console.log(`$ ${command}`)
  if (stdout !== '') {
    let output = stdout.trim()
    if (output.length > maxChars) output = `${output.slice(0, maxChars)}\n...`
    console.log(output)
  }
  if (stderr !== '') console.log(stderr.trim())
  console.log(`[exit=${String(result.exitCode)}]\n`)
  return stdout
}

async function firstDocumentPath(ws: Workspace): Promise<string | null> {
  const output = await run(ws, 'find /knowledge/ -type f | head -n 1')
  const path = output.trim()
  return path !== '' ? path : null
}

async function main(): Promise<void> {
  const vfs = buildVfs()
  const ws = new Workspace({ '/knowledge/': vfs }, { mode: MountMode.READ })
  try {
    console.log('=== Dify Knowledge ===\n')

    await run(ws, 'ls /knowledge/')
    await run(ws, 'find /knowledge/ -type f | head -n 10')

    const firstPath = await firstDocumentPath(ws)
    if (firstPath === null) {
      console.log('No completed documents found in the Dify dataset.')
      return
    }

    const quotedPath = shellQuote(firstPath)
    console.log(`First document: ${firstPath}\n`)

    await run(ws, `cat ${quotedPath}`, 1200)
    await run(ws, `head -n 5 ${quotedPath}`)
    await run(ws, `tail -n 5 ${quotedPath}`)
    await run(ws, `wc ${quotedPath}`)

    // chmod/chown/touch never hit the Dify API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${firstPath} ===`)
    const metaRes = await ws.shell(
      `chmod 640 ${quotedPath} && chown 500:dev ${quotedPath} && touch -t 202601021530 ${quotedPath}`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', firstPath)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    const query = process.env.DIFY_EXAMPLE_QUERY ?? 'getting started'
    const quotedQuery = shellQuote(query)
    await run(ws, `grep -i ${quotedQuery} ${quotedPath}`)
    await run(ws, `search --method hybrid --top-k 5 ${quotedQuery} /knowledge/`, 1200)

    console.log('=== Stats ===')
    console.log(
      `${String(ws.records.length)} ops, ${String(ws.networkBytes)} network bytes, ` +
        `${String(ws.cacheBytes)} cache bytes`,
    )
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
