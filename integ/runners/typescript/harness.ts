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

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// integ/runtime holds the runtime suite (its own schema and runners,
// integ/runtime/run.{py,ts} + cli.sh), not battery cases; keep it out.
const CASE_DIRS = ['unix', 'bash', 'crossmount', 'resources', 'cli', 'session']
const ENC = new TextEncoder()
const DEC = new TextDecoder()

export interface Mount {
  path: string
  resource: string
  backend: string
  mode?: string
  fixture?: string
  // Mount this prefix over an already-built mount's storage instead of
  // allocating fresh storage, so cp/mv can be exercised against two
  // prefixes that address the same bytes.
  alias_of?: string
  // Fixture seeded by the adapter (over the backend API) instead of the
  // harness tee path -- used by read-only backends like box.
  seed?: string
  // Materialise the mount's backing folder even without a fixture --
  // folder-backed services 404 on a root nothing ever created.
  seed_root?: boolean
  folder?: string
  bucket?: string
  volume?: string
  prefix?: string
  root?: string
  drive?: string
}

export interface ServiceEnv {
  python: string[]
  typescript: string[]
}

export interface Target {
  id: string
  hosts: string[]
  service?: string
  epoch?: string
  apps?: string
  mail?: string
  calendar?: string
  forms?: string
  dataset?: string
  agentId?: string
  facet?: string
  clis?: string[]
  // Scope an installed account CLI to this mount's folder, so the CLI and
  // the mount are pointed at the same place.
  cli_scope?: string
  mounts: Mount[]
  // Sessions a case can name via its `session` field. Grants take either the
  // mapping form ({ '/data': 'read' }) or the list form (['/data'], which
  // inherits the mount's own mode).
  sessions?: Record<
    string,
    | Record<string, string>
    | string[]
    | {
        mounts?: Record<string, string> | string[]
        hidden_paths?: { paths?: string[]; patterns?: string[] }
        hidden_vars?: { names?: string[]; patterns?: string[] }
        env?: Record<string, string>
      }
  >
  // Session environment every case on this target runs under. The
  // conformance runner passes the same map to the real binary, so a CLI
  // option that reads a variable is compared under one environment.
  env?: Record<string, string>
}

export interface Expect {
  exit: number
  stdout: string
  stderr: string
  // The stat line the case's `check` must produce, asserted alongside stdout
  // rather than in place of it.
  check?: string
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
  session?: string
  scenario?: ScenarioStep[]
  expect: Expect
  _source?: string
}

export type ScenarioStep =
  | { mutate: { path: string; content: string } }
  | { command: string }

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
  execute(cmd: string, opts?: { stdin?: Uint8Array; sessionId?: string }): Promise<ExecResult>
  dispatch(opName: string, path: string): Promise<unknown>
  cache: { clear(): Promise<void> }
  mounts(): readonly { resource: { index?: { clear(): Promise<void> } } }[]
  createSession(sessionId: string, options: { mounts: Record<string, string> | string[] }): unknown
  env: Record<string, string>
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

/**
 * The service -> per-host required env vars table.
 *
 * An empty list means the host needs nothing because its adapter starts an
 * in-process fake; the two hosts differ here (python self-hosts s3, ssh, hf,
 * box, databricks, discord, linear and dify, typescript does not), so the
 * asymmetry is spelled out per host rather than inferred.
 */
export function loadServices(root: string): Map<string, ServiceEnv> {
  const data = JSON.parse(readFileSync(join(root, 'targets.json'), 'utf8')) as {
    services: Record<string, ServiceEnv>
    targets: Target[]
  }
  const named = new Set(data.targets.map((t) => t.service).filter((s) => s !== undefined))
  const declared = new Set(Object.keys(data.services))
  const undeclared = [...named].filter((s) => !declared.has(s)).sort()
  if (undeclared.length) {
    throw new Error(`targets.json: services missing an entry: ${undeclared.join(', ')}`)
  }
  const unused = [...declared].filter((s) => !named.has(s)).sort()
  if (unused.length) {
    throw new Error(`targets.json: services entry names no target: ${unused.join(', ')}`)
  }
  for (const [name, hosts] of Object.entries(data.services)) {
    if (!Array.isArray(hosts.python) || !Array.isArray(hosts.typescript)) {
      throw new Error(`targets.json: service '${name}' must declare both 'python' and 'typescript'`)
    }
  }
  return new Map(Object.entries(data.services))
}

/**
 * Service names a caller declares it knowingly does not provision.
 *
 * Rejects a name that is not a real service so the list cannot rot into a typo
 * that quietly widens what --strict tolerates.
 */
export function parseAllowSkip(services: Map<string, ServiceEnv>, value: string): Set<string> {
  const names = new Set(
    value
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== ''),
  )
  const unknown = [...names].filter((n) => !services.has(n)).sort()
  if (unknown.length) {
    throw new Error(`--allow-skip names unknown service(s): ${unknown.join(', ')}`)
  }
  return names
}

/** Env vars this host needs for this target and does not have. */
export function missingEnv(
  services: Map<string, ServiceEnv>,
  target: Target,
  host: 'python' | 'typescript',
): string[] {
  if (target.service === undefined) return []
  const entry = services.get(target.service)
  if (entry === undefined) throw new Error(`unknown service: ${target.service}`)
  return entry[host].filter((v) => !process.env[v])
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
  validateCases(root, cases)
  return cases
}

/**
 * Fail loudly on the two ways a case silently stops being tested.
 *
 * A duplicate id collides in the parity runner, which keys rows by
 * (target, id), so one of the pair is dropped from the py/ts diff without a
 * word. A target id that matches no manifest entry means the case never runs
 * anywhere, which reads as "passing" everywhere.
 */
export function validateCases(root: string, cases: Case[]): void {
  const known = new Set(loadTargets(root).keys())
  const seen = new Map<string, string>()
  const duplicates: string[] = []
  const unknown: string[] = []
  for (const c of cases) {
    const first = seen.get(c.id)
    if (first !== undefined) duplicates.push(`${c.id} (${first} and ${c._source ?? '?'})`)
    else seen.set(c.id, c._source ?? '?')
    for (const t of c.targets) {
      if (!known.has(t)) unknown.push(`${c.id} -> ${t} (${c._source ?? '?'})`)
    }
  }
  if (duplicates.length) throw new Error(`duplicate case ids: ${duplicates.join('; ')}`)
  if (unknown.length) {
    throw new Error(`cases naming an unknown target: ${unknown.join('; ')}`)
  }
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

/**
 * Where a fixture's files are, building them first if it says to.
 *
 * A fixture holding a `build.sh` generates its own contents into a temporary
 * directory instead of shipping them. Only git needs this so far, and it needs
 * it absolutely: a repository cannot hold another repository's `.git`, because
 * `git add` silently refuses any path with a `.git` component, so a checked-in
 * tree would look staged and never be. Generating also keeps the fixture
 * readable as a script rather than as zlib blobs.
 *
 * The caller owns the temporary directory when one is returned.
 */
export function buildFixture(base: string): [string, string | null] {
  const script = join(base, 'build.sh')
  if (!existsSync(script)) return [base, null]
  const built = mkdtempSync(join(tmpdir(), 'mirage-integ-fixture-'))
  execFileSync('bash', [script, join(built, 'repo')], { stdio: 'ignore' })
  return [join(built, 'repo'), built]
}

export async function seedFixture(
  ws: ExecWorkspace,
  fixture: string | undefined,
  mountPath: string,
  root: string,
): Promise<void> {
  if (!fixture) return
  const [base, built] = buildFixture(join(root, 'fixtures', fixture))
  try {
    await seedFrom(ws, base, mountPath)
  } finally {
    if (built !== null) rmSync(built, { recursive: true, force: true })
  }
}

async function seedFrom(ws: ExecWorkspace, base: string, mountPath: string): Promise<void> {
  for (const file of walkFiles(base)) {
    const rel = relative(base, file).split(sep).join('/')
    const dest = `${mountPath.replace(/\/+$/, '')}/${rel}`
    const parent = dest.slice(0, dest.lastIndexOf('/'))
    await ws.execute(`mkdir -p ${parent}`)
    await ws.execute(`tee ${dest} > /dev/null`, { stdin: new Uint8Array(readFileSync(file)) })
  }
}

export async function seedMountRoot(ws: ExecWorkspace, mountPath: string): Promise<void> {
  // Prefix-scoped object stores treat an absent prefix as an empty
  // directory, and the gws adapter pre-creates each mount's root folder
  // chain, but folder-backed services (dropbox, sharepoint) 404 when a
  // mount roots at a folder nothing ever created. Writing and removing a
  // marker file rides the same workspace plumbing fixture seeding uses:
  // the upload auto-creates the folder chain and the delete leaves the
  // folders behind, so the mount lists as empty like every other target.
  const marker = `${mountPath.replace(/\/+$/, '')}/.seed`
  await ws.execute(`tee ${marker} > /dev/null`, { stdin: ENC.encode('seed\n') })
  await ws.execute(`rm ${marker}`)
}

export async function runScenario(
  ws: ExecWorkspace,
  mutate: (path: string, content: Uint8Array) => Promise<void>,
  steps: ScenarioStep[],
): Promise<{ exitCode: number; out: string }> {
  const outputs: string[] = []
  let exitCode = 0
  for (const step of steps) {
    if ('mutate' in step) {
      await mutate(step.mutate.path, ENC.encode(step.mutate.content))
      continue
    }
    const result = await ws.execute(step.command)
    outputs.push(DEC.decode(result.stdout))
    exitCode = result.exitCode
  }
  return { exitCode, out: outputs.join('') }
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

/**
 * Substitute {mount} in a case with a target's primary mount path.
 *
 * Lets one case assert a behavior that every backend shares while each target
 * keeps its own mount path. Cases without the token are returned untouched, so
 * this is inert for the existing suite.
 */
// {mount} lets one case assert a behavior every backend shares while each
// target keeps its own mount path. {http} carries the fixture HTTP server's
// base URL, which is only known once the server has bound a port.
export function bindMount(c: Case, mountPath: string): Case {
  const tokens: ReadonlyArray<readonly [string, string]> = [
    ['{mount}', mountPath.replace(/\/+$/, '')],
    ['{http}', process.env.HTTP_ENDPOINT ?? ''],
  ]
  const subst = (text: string): string =>
    tokens.reduce((acc, [token, value]) => acc.split(token).join(value), text)
  const present = tokens.some(
    ([token]) =>
      c.command?.includes(token) === true ||
      c.expect.stdout.includes(token) ||
      c.expect.stderr.includes(token),
  )
  if (!present) return c
  return {
    ...c,
    ...(c.command !== undefined ? { command: subst(c.command) } : {}),
    expect: {
      ...c.expect,
      stdout: subst(c.expect.stdout),
      stderr: subst(c.expect.stderr),
    },
  }
}

/**
 * Run one case and return what it produced.
 *
 * The post-condition a case declares under `check` is returned beside stdout
 * rather than in place of it, so a case can pin both what the command printed
 * and what it left behind.
 */
export async function runCase(
  ws: ExecWorkspace,
  c: Case,
): Promise<{
  exitCode: number
  out: string
  err: string
  elapsed: number
  checkOut: string | null
}> {
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
      checkOut: null,
    }
  }
  const result = await ws.execute(c.command, { sessionId: c.session })
  const elapsed = (performance.now() - start) / 1000
  const out = DEC.decode(result.stdout)
  const checkOut = c.check !== undefined ? await statCheck(ws, c.check) : null
  return {
    exitCode: result.exitCode,
    out,
    err: DEC.decode(result.stderr),
    elapsed,
    checkOut,
  }
}

export function compare(
  c: Case,
  exitCode: number,
  out: string,
  err: string,
  elapsed: number,
  checkOut: string | null = null,
): string[] {
  const diffs: string[] = []
  if (exitCode !== c.expect.exit) diffs.push(`exit: expected ${c.expect.exit}, got ${exitCode}`)
  if (out !== c.expect.stdout)
    diffs.push(`stdout: expected ${JSON.stringify(c.expect.stdout)}, got ${JSON.stringify(out)}`)
  if (err.replace(/\n+$/, '') !== c.expect.stderr.replace(/\n+$/, ''))
    diffs.push(`stderr: expected ${JSON.stringify(c.expect.stderr)}, got ${JSON.stringify(err)}`)
  if (c.check !== undefined && checkOut !== c.expect.check)
    diffs.push(
      `check: expected ${JSON.stringify(c.expect.check)}, got ${JSON.stringify(checkOut)}`,
    )
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
