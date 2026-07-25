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
  mode?: string
  fixture?: string
  // Fixture seeded by the adapter (over the backend API) instead of the
  // harness tee path -- used by read-only backends like box.
  seed?: string
  folder?: string
  bucket?: string
  volume?: string
  prefix?: string
  root?: string
  drive?: string
}

export interface Target {
  id: string
  hosts: string[]
  service?: string
  epoch?: string
  apps?: string
  mail?: string
  dataset?: string
  agentId?: string
  mounts: Mount[]
}

export interface Expect {
  exit: number
  stdout: string
  stderr: string
  elapsed?: { min: number; max: number }
}

export interface StatCheck {
  stat: string
  fields: string[]
}

export interface Case {
  id: string
  seq?: number
  targets: string[]
  command: string
  flags?: string[]
  check?: StatCheck
  provision?: boolean
  clear_cache?: boolean
  consistency?: 'always' | 'lazy'
  scenario?: unknown[]
  expect: Expect
  _source?: string
}

export interface ProvisionInfo {
  networkRead: number | string
  networkWrite: number | string
  cacheRead: number | string
  readOps: number
  cacheHits: number
  precision: string
}

interface ProvisionExec {
  execute(cmd: string, opts: { provision: true }): Promise<ProvisionInfo>
}

export interface ExecResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
}

export interface HarnessStat {
  mode: number | null
  uid: number | string | null
  gid: number | string | null
  modified: string | null
}

export interface ExecWorkspace {
  execute(cmd: string, opts?: { stdin?: Uint8Array }): Promise<ExecResult>
  dispatch(opName: string, path: string): Promise<unknown>
  cache: { clear(): Promise<void> }
  mounts(): readonly { resource: { index?: { clear(): Promise<void> } } }[]
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
    let files: string[]
    try {
      files = walkFiles(dir).filter((f) => f.endsWith('.json')).sort()
    } catch {
      continue
    }
    for (const file of files) {
      const rel = relative(root, file)
      const data = JSON.parse(readFileSync(file, 'utf8')) as { cases: Case[] }
      for (const c of data.cases) {
        c._source = rel
        cases.push(c)
      }
    }
  }
  cases.sort((a, b) => (a.seq ?? 1 << 30) - (b.seq ?? 1 << 30))
  return cases
}

export function walkFiles(base: string): string[] {
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

function checkField(st: HarnessStat, name: string): string {
  let value: string
  if (name === 'mode') {
    value = st.mode !== null ? st.mode.toString(8) : '-'
  } else if (name === 'uid') {
    value = st.uid !== null ? String(st.uid) : '-'
  } else if (name === 'gid') {
    value = st.gid !== null ? String(st.gid) : '-'
  } else {
    // First 19 chars ("2026-01-02T15:30:00") so the Z vs +00:00 suffix
    // never reaches the comparison.
    value = st.modified !== null && st.modified !== '' ? st.modified.slice(0, 19) : '-'
  }
  return `${name}=${value}`
}

export async function statCheck(ws: ExecWorkspace, check: StatCheck): Promise<string> {
  let st: HarnessStat
  try {
    st = (await ws.dispatch('stat', check.stat)) as HarnessStat
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 'absent\n'
    throw err
  }
  return check.fields.map((name) => checkField(st, name)).join(' ') + '\n'
}

function provisionLine(r: ProvisionInfo): string {
  return (
    `net=${r.networkRead} write=${r.networkWrite} ` +
    `cache=${r.cacheRead} ops=${String(r.readOps)} ` +
    `hits=${String(r.cacheHits)} precision=${r.precision}`
  )
}

export async function runCase(
  ws: ExecWorkspace,
  c: Case,
): Promise<{ exitCode: number; out: string; err: string; elapsed: number }> {
  if (c.clear_cache === true) {
    // A full clear means the file cache AND every mount's index cache:
    // remote listings live in the per-resource index, and a listing
    // populated by an earlier case must not leak into this one. Resources
    // without an index cache (e.g. opfs) have nothing to clear.
    await ws.cache.clear()
    for (const m of ws.mounts()) await m.resource.index?.clear()
  }
  const start = performance.now()
  if (c.provision === true) {
    const plan = await (ws as unknown as ProvisionExec).execute(c.command, { provision: true })
    return {
      exitCode: 0,
      out: provisionLine(plan) + '\n',
      err: '',
      elapsed: (performance.now() - start) / 1000,
    }
  }
  const result = await ws.execute(c.command)
  const elapsed = (performance.now() - start) / 1000
  let out = DEC.decode(result.stdout)
  if (c.check !== undefined) out = await statCheck(ws, c.check)
  return {
    exitCode: result.exitCode,
    out,
    err: DEC.decode(result.stderr),
    elapsed,
  }
}

export function compare(
  c: Case,
  exitCode: number,
  out: string,
  err: string,
  elapsed: number,
): string[] {
  const diffs: string[] = []
  if (exitCode !== c.expect.exit) diffs.push(`exit: expected ${c.expect.exit}, got ${exitCode}`)
  if (out !== c.expect.stdout)
    diffs.push(`stdout: expected ${JSON.stringify(c.expect.stdout)}, got ${JSON.stringify(out)}`)
  if (err.replace(/\n+$/, '') !== c.expect.stderr.replace(/\n+$/, ''))
    diffs.push(`stderr: expected ${JSON.stringify(c.expect.stderr)}, got ${JSON.stringify(err)}`)
  const bounds = c.expect.elapsed
  if (bounds !== undefined && (elapsed < bounds.min || elapsed > bounds.max))
    diffs.push(
      `elapsed: expected [${String(bounds.min)}, ${String(bounds.max)}], got ${elapsed.toFixed(3)}`,
    )
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
