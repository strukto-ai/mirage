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

// Conformance gate for the virtualized `tvly` CLI. Every case in
// integ/cli/tvly.json is asserted twice: the shared battery runs it inside a
// mirage workspace, and this runs the SAME line in a real shell with the real
// `tvly` (npm @tavily/cli, pinned by TVLY_VERSION) pointed at the same Tavily
// fake. A golden both agree on is by construction what the official CLI
// prints. Cases that touch a mount path are mirage-only and the ones the
// upstream binary cannot be compared against name their reason; both are
// reported as skipped, never silently dropped.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { start } from './server/kit/typescript/index.ts'
import { API_KEY } from './server/tavily/config.ts'
import { tavilyFake } from './server/tavily/fake.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BATTERY = join(HERE, 'cli', 'tvly.json')
const TVLY_VERSION = '1.0.2'
// Variables the real tvly reads that would make a run depend on the machine:
// a client name or human id changes the headers, and the rest change colour
// and terminal detection.
const UNSET = ['TAVILY_CLIENT_NAME', 'TAVILY_HUMAN_ID', 'FORCE_COLOR', 'COLORTERM']

interface Expect {
  exit: number
  stdout: string
  stderr: string
}

interface Case {
  id: string
  seq: number
  command: string
  expect: Expect
  conformance_skip?: string
}

function isConformable(one: Case): boolean {
  if (one.conformance_skip !== undefined) return false
  return !one.command.includes('/scratch/')
}

function resolveTvly(): string | null {
  const pinned = process.env.TVLY_BIN
  if (pinned !== undefined && pinned !== '') return pinned
  const found = spawnSync('which', ['tvly'], { encoding: 'utf8' })
  if (found.status === 0) return found.stdout.trim()
  return null
}

function show(label: string, value: string): string {
  return `${label}: ${JSON.stringify(value)}`
}

interface Run {
  exit: number
  stdout: string
  stderr: string
}

// Async on purpose. The fake is served by this process's event loop, so a
// synchronous spawn would block the very loop that has to answer the request
// the child just made.
function runLine(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { env, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ exit: code ?? -1, stdout, stderr })
    })
    // `search -` and `research -` read the query from the pipe.
    child.stdin.end()
  })
}

async function main(): Promise<void> {
  const tvly = resolveTvly()
  if (tvly === null) {
    console.error(
      `tvly conformance: no \`tvly\` on PATH and TVLY_BIN unset.\n` +
        `  install with: npm i @tavily/cli@${TVLY_VERSION} && export TVLY_BIN=$PWD/node_modules/.bin/tvly`,
    )
    process.exit(1)
  }
  const home = mkdtempSync(join(tmpdir(), 'tvly-conformance-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(tvly, '..')}:${process.env.PATH ?? ''}`,
    // A fresh home holds no stored login, so the key below is the only
    // credential the binary finds.
    HOME: home,
    NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
    TAVILY_API_KEY: API_KEY,
  }
  for (const name of UNSET) delete env[name]
  const version = execFileSync(tvly, ['--version'], { encoding: 'utf8', env }).trim()
  if (version !== `tavily-cli ${TVLY_VERSION}`) {
    console.error(`tvly conformance: expected tavily-cli ${TVLY_VERSION}, found "${version}"`)
    process.exit(1)
  }

  const battery = JSON.parse(readFileSync(BATTERY, 'utf8')) as { cases: Case[] }
  const cases = [...battery.cases].sort((a, b) => a.seq - b.seq)
  const fake = await start(tavilyFake, 0)
  env.TAVILY_API_BASE_URL = `http://127.0.0.1:${String(fake.port)}`

  const skipped: string[] = []
  const failures: string[] = []
  let checked = 0
  for (const one of cases) {
    if (!isConformable(one)) {
      skipped.push(
        one.conformance_skip === undefined ? one.id : `${one.id} (${one.conformance_skip})`,
      )
      continue
    }
    checked += 1
    const got = await runLine(one.command, env, home)
    const diffs: string[] = []
    if (got.exit !== one.expect.exit)
      diffs.push(`  exit: want ${String(one.expect.exit)}, got ${String(got.exit)}`)
    if (got.stdout !== one.expect.stdout) {
      diffs.push(
        `  ${show('stdout want', one.expect.stdout)}\n  ${show('stdout got ', got.stdout)}`,
      )
    }
    if (got.stderr !== one.expect.stderr) {
      diffs.push(
        `  ${show('stderr want', one.expect.stderr)}\n  ${show('stderr got ', got.stderr)}`,
      )
    }
    if (diffs.length > 0) failures.push(`${one.id} (${one.command})\n${diffs.join('\n')}`)
  }

  await fake.close()
  rmSync(home, { recursive: true, force: true })

  console.log(
    `${version} conformance: ${String(checked)} checked, ${String(skipped.length)} not comparable`,
  )
  for (const one of skipped) console.log(`  skipped: ${one}`)
  if (failures.length > 0) {
    console.error(`\n${String(failures.length)} divergence(s) from the real CLI:\n`)
    for (const one of failures) console.error(`${one}\n`)
    process.exit(1)
  }
  console.log('all conformable cases match the real CLI')
}

await main()
