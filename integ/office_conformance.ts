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

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BATTERY = join(HERE, 'cli', 'office.json')
const FIXTURES = join(HERE, 'fixtures', 'office', 'v1')
const OFFICECLI_VERSION = '1.0.161'
// One-shot runs: no resident process per file, no update check, no install.
const QUIET = {
  OFFICECLI_NO_AUTO_RESIDENT: '1',
  OFFICECLI_SKIP_UPDATE: '1',
  OFFICECLI_NO_AUTO_INSTALL: '1',
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
  conformance_skip?: string
}

function resolveBinary(): string | null {
  const pinned = process.env.OFFICECLI_BIN
  if (pinned !== undefined && pinned !== '') return pinned
  const found = spawnSync('which', ['officecli'], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : null
}

/** What the real tool printed, with `home` gone and its hints naming the
 * command as mirage installs it, `office`. */
function asOffice(text: string, home: string): string {
  return text.replaceAll(home, '').replaceAll("'officecli ", "'office ")
}

function main(): void {
  const binary = resolveBinary()
  if (binary === null) {
    console.error('office conformance: no `officecli` binary on PATH and OFFICECLI_BIN unset.')
    process.exit(1)
  }
  const env = { ...process.env, ...QUIET }
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8', env }).trim()
  if (version !== OFFICECLI_VERSION) {
    console.error(`office conformance: expected ${OFFICECLI_VERSION}, found "${version}"`)
    process.exit(1)
  }

  const battery = JSON.parse(readFileSync(BATTERY, 'utf8')) as { cases: Case[] }
  const cases = [...battery.cases].sort((a, b) => a.seq - b.seq)
  const skipped: string[] = []
  const failures: string[] = []
  let checked = 0
  for (const one of cases) {
    if (one.conformance_skip !== undefined) {
      skipped.push(`${one.id} (${one.conformance_skip})`)
      continue
    }
    checked += 1
    const home = mkdtempSync(join(tmpdir(), 'office-conformance-'))
    const shims = join(home, 'bin')
    mkdirSync(shims)
    mkdirSync(join(home, 'scratch'))
    cpSync(FIXTURES, join(home, 'docs'), { recursive: true })
    const shim = join(shims, 'office')
    writeFileSync(shim, `#!/bin/sh\nexec "${binary}" "$@"\n`)
    chmodSync(shim, 0o755)
    const command = one.command
      .replaceAll('/scratch/', `${home}/scratch/`)
      .replaceAll('/docs/', `${home}/docs/`)
    const got = spawnSync('bash', ['-c', command], {
      cwd: home,
      env: { ...env, PATH: `${shims}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      input: '',
    })
    rmSync(home, { recursive: true, force: true })
    const exit = got.status ?? -1
    const out = asOffice(got.stdout, home)
    const err = asOffice(got.stderr, home)
    const diffs: string[] = []
    if (exit !== one.expect.exit) {
      diffs.push(`  exit: want ${String(one.expect.exit)}, got ${String(exit)}`)
    }
    if (out !== one.expect.stdout) {
      diffs.push(
        `  stdout want: ${JSON.stringify(one.expect.stdout)}\n  stdout got : ${JSON.stringify(out)}`,
      )
    }
    if (err !== one.expect.stderr) {
      diffs.push(
        `  stderr want: ${JSON.stringify(one.expect.stderr)}\n  stderr got : ${JSON.stringify(err)}`,
      )
    }
    if (diffs.length > 0) failures.push(`${one.id} (${one.command})\n${diffs.join('\n')}`)
  }

  console.log(
    `officecli ${version}: ${String(checked)} checked, ${String(skipped.length)} not comparable`,
  )
  for (const one of skipped) console.log(`  skipped: ${one}`)
  if (checked === 0) {
    console.error('office conformance: no case was comparable')
    process.exit(1)
  }
  if (failures.length > 0) {
    console.error(`\n${String(failures.length)} divergence(s) from the real CLI:\n`)
    for (const one of failures) console.error(`${one}\n`)
    process.exit(1)
  }
  console.log('all comparable cases match the real CLI')
}

main()
