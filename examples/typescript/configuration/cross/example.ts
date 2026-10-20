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

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

import {
  DiscordVFS,
  GmailVFS,
  GoogleDriveVFS,
  MountMode,
  S3VFS,
  SlackVFS,
  Workspace,
} from '@struktoai/mirage-node'

// The SDK spelling of the cross-VFS workspace. Its CLI walkthrough, for
// both CLIs, drives the YAML beside the python example:
// examples/python/configuration/cross/README.md.

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

const google = {
  clientId: env('GOOGLE_CLIENT_ID'),
  clientSecret: env('GOOGLE_CLIENT_SECRET'),
  refreshToken: env('GOOGLE_REFRESH_TOKEN'),
}

const s3 = new S3VFS({
  bucket: env('AWS_S3_BUCKET'),
  region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  accessKeyId: env('AWS_ACCESS_KEY_ID'),
  secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
})
const gdrive = new GoogleDriveVFS(google)
const gmail = new GmailVFS(google)
const searchToken = process.env.SLACK_USER_TOKEN
const slack = new SlackVFS({
  token: env('SLACK_BOT_TOKEN'),
  ...(searchToken !== undefined ? { searchToken } : {}),
})
const discord = new DiscordVFS({ token: env('DISCORD_BOT_TOKEN') })

// Stable path that both scripts agree on. Override with the env var
// MIRAGE_CROSS_DIR if you want a different location.
const SNAPSHOT_DIR = process.env.MIRAGE_CROSS_DIR ?? '/tmp/mirage-cross-clone'
const SNAPSHOT_TAR = join(SNAPSHOT_DIR, 'snapshot.tar')
const EXPECTED_JSON = join(SNAPSHOT_DIR, 'expected.json')

// Read-only commands whose output is deterministic between runs.
// The loader script reruns the same commands and asserts identical output.
const FINGERPRINT_COMMANDS = [
  'head -n 1 /s3/data/example.jsonl',
  'cat /s3/data/example.jsonl | wc -l',
  'grep -c "mirage" /s3/data/example.jsonl',
  'head -n 1 "/gdrive/AWS CDK.gdoc.json"',
  'wc -l "/gdrive/AWS CDK.gdoc.json"',
  'cat /s3/data/example.jsonl "/gdrive/AWS CDK.gdoc.json" | wc -l',
]

interface Fingerprint {
  command: string
  exit_code: number
  stdout: string
  stderr: string
}

async function capture(ws: Workspace, cmd: string): Promise<Fingerprint> {
  const r = await ws.shell(cmd)
  return {
    command: cmd,
    exit_code: r.exitCode,
    stdout: r.stdoutText.trim(),
    stderr: r.stderrText.trim(),
  }
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/s3': s3, '/gdrive': gdrive, '/gmail': gmail, '/slack': slack, '/discord': discord },
    { mode: MountMode.WRITE },
  )
  try {
    // gdrive needs `ls` of the parent folder first so the index has
    // the file_id mapping the loader will need too.
    await ws.shell('ls /gdrive/')

    // Warm the cache by running each fingerprint command once and
    // discarding the output. This way the snapshot's cache state
    // matches what the loader will see — and downstream commands like
    // `wc -l` produce identical formatting on both sides (some commands
    // format slightly differently between cache-hit and source-read
    // paths; warming makes the comparison apples-to-apples).
    for (const cmd of FINGERPRINT_COMMANDS) await ws.shell(cmd)

    // ── exercise the workspace (read-only for determinism) ──────────
    console.log('=== capturing fingerprint commands ===\n')
    const fingerprints: Fingerprint[] = []
    for (const cmd of FINGERPRINT_COMMANDS) {
      const cap = await capture(ws, cmd)
      fingerprints.push(cap)
      const head = cap.stdout.slice(0, 80).replaceAll('\n', ' ')
      console.log(`  ${cmd}`)
      console.log(`    exit=${String(cap.exit_code)}  stdout=${JSON.stringify(head)}`)
    }

    // ── snapshot the workspace + expected outputs ──────────────────
    await mkdir(SNAPSHOT_DIR, { recursive: true })
    const size = await ws.snapshot(SNAPSHOT_TAR)
    await writeFile(
      EXPECTED_JSON,
      JSON.stringify({ tar_path: SNAPSHOT_TAR, fingerprints }, null, 2),
    )

    console.log('\n=== saved ===')
    console.log(`  tar:      ${SNAPSHOT_TAR} (${String(size)} bytes)`)
    console.log(`  expected: ${EXPECTED_JSON}`)
    console.log(
      '\nNow run: pnpm -C examples/typescript exec tsx configuration/cross/load_check.ts',
    )
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
