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

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

import {
  DiscordVFS,
  GmailVFS,
  GoogleDriveVFS,
  S3VFS,
  SlackVFS,
  Workspace,
  type BaseVFS,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

const EXPECTED_JSON = process.env.MIRAGE_CROSS_EXPECTED ?? '/tmp/mirage-cross-clone/expected.json'

const FIELDS = ['exit_code', 'stdout', 'stderr'] as const

interface Fingerprint {
  command: string
  exit_code: number
  stdout: string
  stderr: string
}

interface Expected {
  tar_path: string
  fingerprints: Fingerprint[]
}

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

function freshMounts(): Record<string, BaseVFS> {
  const google = {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_REFRESH_TOKEN'),
  }
  const searchToken = process.env.SLACK_USER_TOKEN
  return {
    '/s3': new S3VFS({
      bucket: env('AWS_S3_BUCKET'),
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      accessKeyId: env('AWS_ACCESS_KEY_ID'),
      secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
    }),
    '/gdrive': new GoogleDriveVFS(google),
    '/gmail': new GmailVFS(google),
    '/slack': new SlackVFS({
      token: env('SLACK_BOT_TOKEN'),
      ...(searchToken !== undefined ? { searchToken } : {}),
    }),
    '/discord': new DiscordVFS({ token: env('DISCORD_BOT_TOKEN') }),
  }
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

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
}

function summarize(expected: string | number, got: string | number): string {
  if (expected === got) return 'OK'
  if (typeof expected === 'string' && typeof got === 'string') {
    if (expected.length > 60 || got.length > 60) {
      return (
        `DIFF (lengths exp=${String(expected.length)} got=${String(got.length)}; ` +
        `first diff at char ${String(firstDiff(expected, got))})`
      )
    }
  }
  return `DIFF (expected=${JSON.stringify(expected)}, got=${JSON.stringify(got)})`
}

async function main(): Promise<void> {
  if (!existsSync(EXPECTED_JSON)) {
    console.log(`ERROR: ${EXPECTED_JSON} not found.`)
    console.log(
      'Run examples/typescript/configuration/cross/example.ts first to create the snapshot.',
    )
    process.exit(1)
  }

  const expectedDoc = JSON.parse(await readFile(EXPECTED_JSON, 'utf-8')) as Expected

  const tarPath = expectedDoc.tar_path
  console.log(`=== loading ${tarPath} ===`)
  const ws = await Workspace.load(tarPath, {}, freshMounts())
  let nDiff = 0
  try {
    const mounts = ws
      .mounts()
      .map((m) => m.prefix)
      .sort()
    console.log(`  mounts: [${mounts.map((p) => `'${p}'`).join(', ')}]`)
    console.log(`  loaded history entries: ${String((await ws.history()).length)}`)

    // gdrive index belongs to the freshly-supplied VFS (override
    // drops the saved index). Repopulate it the same way the original
    // script did, so the loader's commands resolve the same paths.
    await ws.shell('ls /gdrive/')

    // ── re-execute fingerprint commands and compare ─────────────────
    console.log(
      `\n=== re-running ${String(expectedDoc.fingerprints.length)} commands and comparing ===\n`,
    )

    let nMatch = 0
    for (const expected of expectedDoc.fingerprints) {
      const got = await capture(ws, expected.command)
      const verdicts = FIELDS.map((field) => [field, summarize(expected[field], got[field])])
      const allOk = verdicts.every(([, verdict]) => verdict === 'OK')

      console.log(`  ${allOk ? '✓' : '✗'} ${expected.command}`)
      for (const [field, verdict] of verdicts) {
        if (verdict !== 'OK') console.log(`      ${String(field)}: ${String(verdict)}`)
      }
      if (allOk) nMatch += 1
      else nDiff += 1
    }

    console.log(`\n=== summary: ${String(nMatch)} match, ${String(nDiff)} differ ===`)
  } finally {
    await ws.close()
  }
  if (nDiff > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
