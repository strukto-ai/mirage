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

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BATTERY = join(HERE, 'cli', 'pdf.json')
const FIXTURES = join(HERE, 'fixtures', 'pdf', 'v1')
const POPPLER_VERSION = '25.03.0'
// The image the cases run in: debian:stable-slim pinned by digest, with
// poppler-utils and poppler-data installed (see test_integ.yml).
const IMAGE = process.env.POPPLER_IMAGE ?? 'mirage-poppler'

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

/** Run `command` under bash in the image, the fixtures at /docs and `scratch` at /scratch. */
function inImage(command: string, scratch: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '-v',
      `${FIXTURES}:/docs:ro`,
      '-v',
      `${scratch}:/scratch`,
      '-w',
      '/',
      IMAGE,
      'bash',
      '-c',
      command,
    ],
    { encoding: 'utf8', input: '' },
  )
}

function main(): void {
  const probe = spawnSync('docker', ['run', '--rm', IMAGE, 'pdftotext', '-v'], {
    encoding: 'utf8',
  })
  if (probe.status === null || probe.error !== undefined) {
    console.error(`pdf conformance: docker could not run image ${IMAGE}.`)
    process.exit(1)
  }
  const version = probe.stderr.split('\n')[0] ?? ''
  if (version !== `pdftotext version ${POPPLER_VERSION}`) {
    console.error(`pdf conformance: expected poppler ${POPPLER_VERSION}, found "${version}"`)
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
    const scratch = mkdtempSync(join(tmpdir(), 'pdf-conformance-'))
    const got = inImage(one.command, scratch)
    rmSync(scratch, { recursive: true, force: true })
    const exit = got.status ?? -1
    const diffs: string[] = []
    if (exit !== one.expect.exit) {
      diffs.push(`  exit: want ${String(one.expect.exit)}, got ${String(exit)}`)
    }
    if (got.stdout !== one.expect.stdout) {
      diffs.push(
        `  stdout want: ${JSON.stringify(one.expect.stdout)}\n  stdout got : ${JSON.stringify(got.stdout)}`,
      )
    }
    if (got.stderr !== one.expect.stderr) {
      diffs.push(
        `  stderr want: ${JSON.stringify(one.expect.stderr)}\n  stderr got : ${JSON.stringify(got.stderr)}`,
      )
    }
    if (diffs.length > 0) failures.push(`${one.id} (${one.command})\n${diffs.join('\n')}`)
  }

  console.log(
    `poppler ${POPPLER_VERSION}: ${String(checked)} checked, ${String(skipped.length)} not comparable`,
  )
  for (const one of skipped) console.log(`  skipped: ${one}`)
  if (checked === 0) {
    console.error('pdf conformance: no case was comparable')
    process.exit(1)
  }
  if (failures.length > 0) {
    console.error(`\n${String(failures.length)} divergence(s) from the real poppler-utils:\n`)
    for (const one of failures) console.error(`${one}\n`)
    process.exit(1)
  }
  console.log('all comparable cases match the real poppler-utils')
}

main()
