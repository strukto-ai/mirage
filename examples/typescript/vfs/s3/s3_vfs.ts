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
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { MountMode, S3VFS, Workspace, patchNodeFs, type S3Config } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function baseConfig(): S3Config {
  const bucket = process.env.AWS_S3_BUCKET
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      'AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY must be set (e.g. in .env.development)',
    )
  }
  return {
    bucket,
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p)
    return true
  } catch {
    return false
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function firstRecords(path: string, count: number, width: number): Promise<void> {
  const text = await fs.promises.readFile(path, 'utf-8')
  for (const [i, line] of text.split('\n').slice(0, count).entries()) {
    const rec = JSON.parse(line) as unknown
    console.log(`  [${String(i)}] ${JSON.stringify(rec).slice(0, width)}...`)
  }
}

async function main(): Promise<void> {
  const config = baseConfig()
  const deepConfig: S3Config = { ...config, keyPrefix: 'subdata/subsubdata/' }
  const ws = new Workspace(
    { '/s3/': new S3VFS(config), '/deep/': new S3VFS(deepConfig) },
    { mode: MountMode.READ },
  )
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.readFile() reads from S3 transparently ===\n')

    console.log('--- fs.readdir() root ---')
    for (const e of await fs.promises.readdir('/s3')) console.log(`  ${e}`)

    console.log('\n--- isDir() on prefix ---')
    console.log(`  /s3/data: ${String(await isDir('/s3/data'))}`)

    console.log('\n--- fs.readFile() + parse ---')
    await firstRecords('/s3/data/example.jsonl', 3, 100)

    console.log('\n--- fs.readdir() ---')
    for (const e of await fs.promises.readdir('/s3/data')) console.log(`  ${e}`)

    console.log('\n--- exists via fs.promises.stat() ---')
    console.log(`  example.jsonl: ${String(await exists('/s3/data/example.jsonl'))}`)
    console.log(`  nonexistent: ${String(await exists('/s3/data/nope.txt'))}`)

    console.log('\n--- VFS commands ---')
    const result = await ws.shell('grep -c mirage /s3/data/example.jsonl')
    console.log(`  grep matches: ${result.stdoutText.trim()}`)

    console.log('\n=== KEY_PREFIX MOUNT (/deep → subdata/subsubdata/) ===\n')
    console.log(`  keyPrefix = ${JSON.stringify(deepConfig.keyPrefix)}\n`)

    console.log("--- fs.readdir('/deep') ---")
    for (const e of await fs.promises.readdir('/deep')) console.log(`  ${e}`)

    console.log('\n--- exists / isDir / size ---')
    console.log(`  /deep/example.jsonl  exists: ${String(await exists('/deep/example.jsonl'))}`)
    console.log(`  /deep/example.json   isdir : ${String(await isDir('/deep/example.json'))}`)
    const size = (await fs.promises.stat('/deep/example.json')).size
    console.log(`  /deep/example.json   size  : ${String(size)} bytes`)

    console.log('\n--- fs.readFile() first 3 records ---')
    await firstRecords('/deep/example.jsonl', 3, 90)

    console.log('\n--- VFS commands against /deep ---')
    let r = await ws.shell('grep -c mirage /deep/example.jsonl')
    console.log(`  grep -c mirage     : ${r.stdoutText.trim()}`)
    r = await ws.shell('rg -l mirage /deep')
    console.log(`  rg -l mirage       : ${r.stdoutText.trim()}`)
    r = await ws.shell('jq .metadata.version /deep/example.json')
    console.log(`  jq .metadata.version: ${r.stdoutText.trim()}`)

    console.log('\n--- bash history ---')
    const history = await fs.promises.readFile('/.bash_history', 'utf-8')
    const histLines = history.split('\n').filter((line) => line.trim() !== '')
    for (const line of histLines.slice(0, 6)) {
      console.log(`  ${line.trimEnd().slice(0, 120)}`)
    }

    const total = ws.records.reduce((acc, rec) => acc + rec.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
