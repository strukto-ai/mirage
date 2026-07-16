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

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CASE_DIRS = ['unix', 'bash', 'crossmount', 'runtime', 'resources', 'cli']
const ENC = new TextEncoder()
const DEC = new TextDecoder()

export interface Mount {
  path: string
  resource: string
  backend: string
  fixture?: string
}

export interface Target {
  id: string
  hosts: string[]
  service?: string
  mounts: Mount[]
}

export interface Expect {
  exit: number
  stdout: string
  stderr: string
}

export interface Case {
  id: string
  seq?: number
  targets: string[]
  command: string
  flags?: string[]
  expect: Expect
  _source?: string
}

export interface ExecResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
}

export interface ExecWorkspace {
  execute(cmd: string, opts?: { stdin?: Uint8Array }): Promise<ExecResult>
  close(): Promise<void>
}

export function integRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function loadTargets(root: string): Map<string, Target> {
  const data = JSON.parse(readFileSync(join(root, 'targets.json'), 'utf8')) as {
    targets: Target[]
  }
  return new Map(data.targets.map((t) => [t.id, t]))
}

export function loadCases(root: string): Case[] {
  const cases: Case[] = []
  for (const name of CASE_DIRS) {
    const dir = join(root, name)
    let entries: string[]
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    } catch {
      continue
    }
    for (const file of entries) {
      const rel = join(name, file)
      const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { cases: Case[] }
      for (const c of data.cases) {
        c._source = rel
        cases.push(c)
      }
    }
  }
  cases.sort((a, b) => (a.seq ?? 1 << 30) - (b.seq ?? 1 << 30))
  return cases
}

function walkFiles(base: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(base)) {
    const full = join(base, entry)
    if (statSync(full).isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

export async function seedFixture(
  ws: ExecWorkspace,
  fixture: string | undefined,
  mountPath: string,
  root: string,
): Promise<void> {
  if (!fixture) return
  const base = join(root, 'fixtures', fixture)
  for (const file of walkFiles(base)) {
    const rel = relative(base, file).split(sep).join('/')
    const dest = `${mountPath.replace(/\/+$/, '')}/${rel}`
    const parent = dest.slice(0, dest.lastIndexOf('/'))
    await ws.execute(`mkdir -p ${parent}`)
    await ws.execute(`tee ${dest} > /dev/null`, { stdin: new Uint8Array(readFileSync(file)) })
  }
}

export async function runCase(
  ws: ExecWorkspace,
  c: Case,
): Promise<{ exitCode: number; out: string; err: string }> {
  const result = await ws.execute(c.command)
  return {
    exitCode: result.exitCode,
    out: DEC.decode(result.stdout),
    err: DEC.decode(result.stderr),
  }
}

export function compare(c: Case, exitCode: number, out: string, err: string): string[] {
  const diffs: string[] = []
  if (exitCode !== c.expect.exit) diffs.push(`exit: expected ${c.expect.exit}, got ${exitCode}`)
  if (out !== c.expect.stdout)
    diffs.push(`stdout: expected ${JSON.stringify(c.expect.stdout)}, got ${JSON.stringify(out)}`)
  if (err.replace(/\n+$/, '') !== c.expect.stderr.replace(/\n+$/, ''))
    diffs.push(`stderr: expected ${JSON.stringify(c.expect.stderr)}, got ${JSON.stringify(err)}`)
  return diffs
}

export class Report {
  passed = 0
  failed = 0
  failures: string[] = []

  record(target: string, caseId: string, diffs: string[]): void {
    if (diffs.length) {
      this.failed++
      const joined = diffs.join('; ')
      this.failures.push(`[${target}] ${caseId}: ${joined}`)
      process.stdout.write(`FAIL [${target}] ${caseId}: ${joined}\n`)
    } else {
      this.passed++
      process.stdout.write(`ok   [${target}] ${caseId}\n`)
    }
  }

  summary(): string {
    return `${String(this.passed)} passed, ${String(this.failed)} failed`
  }
}

export { ENC }
