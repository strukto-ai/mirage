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
import { ChromaVFS, MountMode, SEARCH, Workspace, type FileStat } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function intEnv(name: string, fallback: number): number {
  const value = process.env[name]
  return value === undefined ? fallback : Number.parseInt(value, 10)
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

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

function buildVfs(): ChromaVFS {
  return new ChromaVFS({
    config: {
      host: process.env.CHROMA_HOST ?? 'localhost',
      port: intEnv('CHROMA_PORT', 8000),
      ssl: boolEnv('CHROMA_SSL', false),
      collectionName: requireEnv('CHROMA_COLLECTION'),
      slugField: process.env.CHROMA_SLUG_FIELD ?? 'page_slug',
      chunkIndexField: process.env.CHROMA_CHUNK_INDEX_FIELD ?? 'chunk_index',
    },
  })
}

async function run(ws: Workspace, command: string, maxChars = 1000): Promise<string> {
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
  ws.registerCli('search', SEARCH)
  try {
    console.log('=== Chroma Knowledge ===\n')

    await run(ws, 'ls /knowledge/')
    await run(ws, 'tree /knowledge/', 1500)
    await run(ws, 'find /knowledge/ -type f | head -n 10')

    const firstPath = await firstDocumentPath(ws)
    if (firstPath === null) {
      console.log('No documents found in the Chroma path tree.')
      return
    }

    const quotedPath = shellQuote(firstPath)
    console.log(`First document: ${firstPath}\n`)

    await run(ws, `cat ${quotedPath}`, 1500)

    // chmod/chown/touch never hit Chroma: attrs land in the workspace
    // namespace (durable, snapshot-captured) and merge into
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
    await run(ws, `head -n 5 ${quotedPath}`)
    await run(ws, `tail -n 5 ${quotedPath}`)

    const query = process.env.CHROMA_EXAMPLE_QUERY ?? 'getting started'
    const quotedQuery = shellQuote(query)
    await run(ws, `grep -in ${quotedQuery} /knowledge/`, 1500)
    await run(ws, `search --top-k 5 ${quotedQuery} /knowledge/`, 1500)

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
