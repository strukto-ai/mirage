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

// Conformance gate for the virtualized `ntn` CLI. Every case in
// integ/cli/ntn.json is asserted twice: the shared battery runs it inside a
// mirage workspace, and this runs the SAME line in a real shell with the real
// `ntn` binary (npm `ntn`, pinned by NTN_VERSION) pointed at the same mock
// server. A golden that both agree on is by construction what the official CLI
// prints, so mirage's grammar and rendering cannot drift from upstream without
// a red build. Cases that read a mount path are mirage-only and reported as
// skipped, never silently dropped.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startMockServer } from './server/notion_server.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BATTERY = join(HERE, 'cli', 'ntn.json')
const TARGETS = join(HERE, 'targets.json')
const NTN_VERSION = '0.21.9'
const TOKEN = 'integ-test'
// The battery's own target declares the session environment both hosts run
// under, and the real binary gets the same map, or the two runs of a line are
// not comparable: an option that reads a variable (ntn's --notion-version off
// NOTION_API_VERSION) prints in a usage line only when it is set.
const TARGET_ID = 'cli-ntn'
// Required rather than defaulted, and load-bearing: left unset the binary
// resolves the newest Notion-Version by fetching developers.notion.com at
// startup, which makes every case depend on the network and hangs when that
// host throttles.
const VERSION_VAR = 'NOTION_API_VERSION'

function targetEnv(): Record<string, string> {
  const doc = JSON.parse(readFileSync(TARGETS, 'utf8')) as {
    targets: { id: string; env?: Record<string, string> }[]
  }
  const target = doc.targets.find((one) => one.id === TARGET_ID)
  if (target === undefined) throw new Error(`${TARGET_ID} is not in targets.json`)
  const env = target.env ?? {}
  if (env[VERSION_VAR] === undefined) {
    throw new Error(`${TARGET_ID} must declare ${VERSION_VAR} in targets.json`)
  }
  return env
}

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
  // Set on the handful of cases the upstream binary cannot be compared
  // against, with the reason. Never omit the case instead: an untested line
  // that looks tested is the failure mode this whole file exists to prevent.
  conformance_skip?: string
}

// A line that names a mount path exercises the VFS, which the upstream binary
// has no equivalent for; everything else is a pure CLI invocation (possibly
// piped through jq/head/tail/cut, which the host shell supplies).
function isConformable(one: Case): boolean {
  if (one.conformance_skip !== undefined) return false
  return !/\/notion\/|\/scratch\//.test(one.command)
}

function resolveNtn(): string | null {
  const pinned = process.env.NTN_BIN
  if (pinned !== undefined && pinned !== '') return pinned
  const found = spawnSync('which', ['ntn'], { encoding: 'utf8' })
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

// Async on purpose. The mock is served by this process's event loop, so a
// synchronous spawn would block the very loop that has to answer the request
// the child just made, and every case would sit until its socket timed out.
function runLine(command: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { env })
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
    // `pages create` reads Markdown from the pipe when --content is absent.
    child.stdin.end()
  })
}

async function main(): Promise<void> {
  const ntn = resolveNtn()
  if (ntn === null) {
    console.error(
      `ntn conformance: no \`ntn\` binary on PATH and NTN_BIN unset.\n` +
        `  install with: npm i ntn@${NTN_VERSION} && export NTN_BIN=$PWD/node_modules/.bin/ntn`,
    )
    process.exit(1)
  }
  const version = execFileSync(ntn, ['--version'], { encoding: 'utf8' }).trim()
  if (!version.endsWith(NTN_VERSION)) {
    console.error(`ntn conformance: expected ntn ${NTN_VERSION}, found "${version}"`)
    process.exit(1)
  }

  const battery = JSON.parse(readFileSync(BATTERY, 'utf8')) as { cases: Case[] }
  const cases = [...battery.cases].sort((a, b) => a.seq - b.seq)
  const { server, port } = await startMockServer()
  const home = mkdtempSync(join(tmpdir(), 'ntn-conformance-'))
  const env = {
    ...process.env,
    PATH: `${join(ntn, '..')}:${process.env.PATH ?? ''}`,
    NOTION_API_BASE_URL: `http://127.0.0.1:${String(port)}`,
    NOTION_API_TOKEN: TOKEN,
    NOTION_KEYRING: '0',
    NOTION_HOME: home,
    ...targetEnv(),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    NO_COLOR: '1',
  }

  const skipped: string[] = []
  const failures: string[] = []
  let checked = 0
  for (const one of cases) {
    if (!isConformable(one)) {
      skipped.push(one.conformance_skip === undefined ? one.id : `${one.id} (${one.conformance_skip})`)
      continue
    }
    checked += 1
    if (process.env.NTN_CONFORMANCE_TRACE === '1') process.stderr.write(`. ${one.id}\n`)
    const got = await runLine(one.command, env)
    const diffs: string[] = []
    if (got.exit !== one.expect.exit) diffs.push(`  exit: want ${String(one.expect.exit)}, got ${String(got.exit)}`)
    if (got.stdout !== one.expect.stdout) {
      diffs.push(`  ${show('stdout want', one.expect.stdout)}\n  ${show('stdout got ', got.stdout)}`)
    }
    if (got.stderr !== one.expect.stderr) {
      diffs.push(`  ${show('stderr want', one.expect.stderr)}\n  ${show('stderr got ', got.stderr)}`)
    }
    if (diffs.length > 0) failures.push(`${one.id} (${one.command})\n${diffs.join('\n')}`)
  }

  server.close()
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
