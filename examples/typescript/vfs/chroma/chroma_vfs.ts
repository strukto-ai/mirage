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
import { ChromaVFS, MountMode, patchNodeFs, Workspace } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

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

async function firstFile(directory: string): Promise<string | null> {
  for (const entry of await fs.promises.readdir(directory)) {
    const path = `${directory.replace(/\/+$/, '')}/${entry}`
    const stat = await fs.promises.stat(path)
    if (stat.isDirectory()) {
      const found = await firstFile(path)
      if (found !== null) return found
    } else if (stat.isFile()) {
      return path
    }
  }
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.promises.stat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return false
  }
}

async function main(): Promise<void> {
  const vfs = buildVfs()
  const ws = new Workspace({ '/knowledge/': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== Chroma VFS ===\n')

    console.log("--- fs.promises.readdir('/knowledge') ---")
    for (const entry of (await fs.promises.readdir('/knowledge')).slice(0, 20)) {
      console.log(`  ${entry}`)
    }

    const path = await firstFile('/knowledge')
    if (path === null) {
      console.log('\nNo documents found in the Chroma path tree.')
      return
    }

    console.log(`\n--- fs.promises.readFile('${path}') ---`)
    const content = await fs.promises.readFile(path, 'utf-8')
    const preview = content.slice(0, 1500)
    console.log(preview)
    if (content.length > preview.length) console.log('...')

    console.log('\n--- fs.promises.stat metadata ---')
    const stat = await fs.promises.stat(path)
    console.log(`  exists: ${String(await exists(path))}`)
    console.log(`  isfile: ${String(stat.isFile())}`)
    console.log(`  size: ${String(stat.size)}`)

    const records = ws.records
    const total = records.reduce((sum, record) => sum + record.bytes, 0)
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
