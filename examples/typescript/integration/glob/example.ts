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

import {
  GitHubVFS,
  GoogleDriveVFS,
  MountMode,
  S3VFS,
  Workspace,
  type GDriveConfig,
  type S3Config,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

const s3Config: S3Config = {
  bucket: env('AWS_S3_BUCKET'),
  region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  accessKeyId: env('AWS_ACCESS_KEY_ID'),
  secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
}
const gdriveConfig: GDriveConfig = {
  clientId: env('GOOGLE_CLIENT_ID'),
  clientSecret: env('GOOGLE_CLIENT_SECRET'),
  refreshToken: env('GOOGLE_REFRESH_TOKEN'),
}

function opsSummary(ws: Workspace): string {
  const records = ws.records
  const total = records.reduce((sum, r) => sum + r.bytes, 0)
  return `${String(records.length)} ops, ${String(total)} bytes transferred`
}

function lines(text: string): string[] {
  const trimmed = text.trim()
  return trimmed === '' ? [] : trimmed.split('\n')
}

async function main(): Promise<void> {
  // GitHub fetches the repo tree when the mount is built, so it is the
  // one mount awaited before the workspace exists.
  const github = await GitHubVFS.create({ token: env('GITHUB_TOKEN'), owner: 'strukto', repo: 'mirage' })

  const ws = new Workspace(
    {
      '/s3/': new S3VFS(s3Config),
      '/gdrive/': new GoogleDriveVFS(gdriveConfig),
      '/github/': github,
    },
    { mode: MountMode.READ },
  )
  try {
    // ── prime gdrive cache ──
    await ws.shell('ls /gdrive/')
    await ws.shell('ls /gdrive/mirage/')

    // ── S3: grep on single file vs directory ──
    console.log('\n=== S3: SINGLE FILE vs DIRECTORY ===\n')

    let r = await ws.shell('grep mirage /s3/data/example.jsonl | wc -l')
    console.log(`single file: ${r.stdoutText.trim()} matches`)

    r = await ws.shell('rg -l mirage /s3/data/')
    console.log(`directory rg -l: ${String(lines(r.stdoutText).length)} files match`)
    console.log(`Stats: ${opsSummary(ws)}`)

    // ── Google Drive: grep with streaming ──
    console.log('\n=== GDRIVE: GREP WITH STREAMING ===\n')

    r = await ws.shell('grep queue-operation /gdrive/mirage/example.jsonl | wc -l')
    console.log(`grep | wc: ${r.stdoutText.trim()} matches`)

    r = await ws.shell('grep queue-operation /gdrive/mirage/example.jsonl | head -n 3')
    console.log(`grep | head -n 3: ${String(lines(r.stdoutText).length)} lines`)

    console.log(`Stats: ${opsSummary(ws)}`)

    // ── GitHub: rg with search_code optimization ──
    console.log('\n=== GITHUB: RG (search_code optimization) ===\n')

    r = await ws.shell('rg -l workspace /github/mirage/workspace/workspace.py')
    const files = lines(r.stdoutText)
    console.log(`rg -l workspace (single file): ${String(files.length)} files`)
    if (files.length > 0) console.log(`  ${files[0]}`)

    r = await ws.shell('rg -l import /github/mirage/')
    if (r.stderrText !== '') {
      console.log(`rg on large dir: ${r.stderrText.trim()}`)
    } else {
      console.log(`rg -l import (large dir): ${String(lines(r.stdoutText).length)} files`)
    }

    r = await ws.shell('grep -c def /github/mirage/commands/config.py')
    console.log(`grep -c def config.py: ${r.stdoutText.trim()}`)

    console.log(`Stats: ${opsSummary(ws)}`)

    // ── cross-VFS consistency ──
    console.log('\n=== CROSS-VFS: SAME DATA ===\n')

    let r1 = await ws.shell('wc -l /s3/data/example.jsonl')
    let r2 = await ws.shell('wc -l /gdrive/mirage/example.jsonl')
    console.log(`s3 wc -l: ${r1.stdoutText.trim()}`)
    console.log(`gdrive wc -l: ${r2.stdoutText.trim()}`)

    r1 = await ws.shell('grep -c queue-operation /s3/data/example.jsonl')
    r2 = await ws.shell('grep -c queue-operation /gdrive/mirage/example.jsonl')
    console.log(`s3 grep -c queue-operation: ${r1.stdoutText.trim()}`)
    console.log(`gdrive grep -c queue-operation: ${r2.stdoutText.trim()}`)

    // ── bash history ──
    console.log('\n=== BASH HISTORY ===\n')

    console.log(`Total ops: ${opsSummary(ws)}`)
    console.log(`Commands recorded: ${String((await ws.history()).length)}`)

    r = await ws.shell('tail -n 6 /.bash_history')
    for (const line of lines(r.stdoutText)) console.log(`  ${line.slice(0, 120)}`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
