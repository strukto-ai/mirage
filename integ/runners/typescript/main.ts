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

import { writeFileSync } from 'node:fs'
import { ADAPTERS } from './adapters.ts'
import type { Case, Target } from './harness.ts'
import {
  Report,
  compare,
  integRoot,
  loadCases,
  loadTargets,
  runCase,
  seedFixture,
} from './harness.ts'

const TS_HOSTS = ['typescript-node', 'typescript-browser']

interface EmitRow {
  target: string
  id: string
  exit: number
  stdout: string
  stderr: string
}

function parseArgs(): { targets: string[]; emit: string | undefined } {
  const targets: string[] = []
  let emit: string | undefined
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && i + 1 < argv.length) targets.push(argv[++i])
    else if (argv[i] === '--emit' && i + 1 < argv.length) emit = argv[++i]
  }
  return { targets, emit }
}

async function runTarget(
  target: Target,
  cases: Case[],
  root: string,
  report: Report | null,
  emit: EmitRow[] | null,
): Promise<void> {
  const { ws, cleanup } = await ADAPTERS[target.mounts[0].resource](target)
  try {
    for (const mount of target.mounts) await seedFixture(ws, mount.fixture, mount.path, root)
    for (const c of cases) {
      if (!c.targets.includes(target.id)) continue
      const { exitCode, out, err } = await runCase(ws, c)
      if (emit !== null) {
        emit.push({ target: target.id, id: c.id, exit: exitCode, stdout: out, stderr: err })
      } else if (report !== null) {
        report.record(target.id, c.id, compare(c, exitCode, out, err))
      }
    }
  } finally {
    await cleanup()
  }
}

async function main(): Promise<void> {
  const root = integRoot()
  const manifest = loadTargets(root)
  const cases = loadCases(root)

  const { targets, emit: emitPath } = parseArgs()
  const ids = targets.length ? targets : [...manifest.keys()]
  const report = emitPath ? null : new Report()
  const emit: EmitRow[] | null = emitPath ? [] : null
  for (const id of ids) {
    const target = manifest.get(id)
    if (!target) throw new Error(`unknown target: ${id}`)
    if (!target.hosts.some((h) => TS_HOSTS.includes(h))) {
      process.stderr.write(`skip [${id}]: not a typescript host\n`)
      continue
    }
    if (!(target.mounts[0].resource in ADAPTERS)) {
      process.stderr.write(`skip [${id}]: no typescript adapter\n`)
      continue
    }
    await runTarget(target, cases, root, report, emit)
  }

  if (emitPath) {
    writeFileSync(emitPath, JSON.stringify(emit))
    return
  }
  if (report === null) return
  process.stdout.write(`\n${report.summary()}\n`)
  if (report.failed) process.exit(1)
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
