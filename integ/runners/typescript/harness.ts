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
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import { resolveReadSpec } from '@struktoai/mirage-core/workspace/mount/read_policy'
import type { ReadSpec } from '@struktoai/mirage-node'
import { undecodable, type Case, type ExecWorkspace, type ScenarioStep } from './execution.ts'

// integ/runtime holds the runtime suite (its own schema and runners,
// integ/runtime/run.{py,ts} + cli.sh), not battery cases; keep it out.
const CASE_DIRS = ['unix', 'bash', 'crossmount', 'vfs', 'cli', 'session', 'console', 'secrets']
const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { ignoreBOM: true })

export interface Mount {
  path: string
  vfs: string
  backend: string
  mode?: string
  config?: Record<string, unknown>
  fixture?: string
  host_fixture?: string
  // Mount this prefix over an already-built mount's storage instead of
  // allocating fresh storage, so cp/mv can be exercised against two
  // prefixes that address the same bytes.
  alias_of?: string
  // A ram mount caches its reads, so a target's file cache sees them.
  caches_reads?: boolean
  // Fixture seeded by the adapter (over the backend API) instead of the
  // harness tee path -- used by read-only backends like box.
  seed?: string
  // Materialise the mount's backing folder even without a fixture --
  // folder-backed services 404 on a root nothing ever created.
  seed_root?: boolean
  folder?: string
  bucket?: string
  // The repository a repo-shaped mount names (github, hf_hub).
  repo?: string
  volume?: string
  prefix?: string
  root?: string
  // The bases an airtable mount is scoped to (AirtableConfig.base_ids).
  base_ids?: string[]
  drive?: string
}

export interface ServiceEnv {
  python: string[]
  typescript: string[]
  // The fake behind this service holds ONE world rather than a namespace per
  // run, so two targets on it can never be in flight together. Everything
  // else mints a fresh run id per open and is free to overlap.
  shared?: boolean
}

const SERVICE_KEYS = new Set(['python', 'typescript', 'shared'])

/**
 * What runs one target. The pool takes it as an argument so a gate can pass a
 * recorder and watch what actually overlaps, which no end-to-end run can show:
 * every service-free target finishes in one event-loop tick.
 */
export type TargetRunner = (
  target: Target,
  cases: Case[],
  root: string,
  report: Report | null,
  emit: EmitRow[] | null,
) => Promise<void>

export interface EmitRow {
  target: string
  id: string
  exit: number
  stdout: string
  stderr: string
  check: string | null
}

export interface Target {
  id: string
  hosts: string[]
  // This target's opener touches process-global state, so it runs alone --
  // not merely apart from its own service's other targets: opfs replaces
  // `globalThis.navigator`, and a `secrets-*` target registers a fetch
  // function under a fixed name in the process-global source registry.
  exclusive?: boolean
  service?: string
  epoch?: string
  apps?: string
  mail?: string
  calendar?: string
  forms?: string
  // Documents that carry tabs, seeded through /reset extras because the
  // Docs API cannot create a tab.
  docs?: string
  dataset?: string
  agentId?: string
  facet?: string
  // Where background-job consoles live: { type: 'redis' } puts each
  // job's console on its own Redis stream (REDIS_URL). Only the ram
  // opener consults it; main.ts refuses it on any other VFS.
  console?: { type?: string }
  // Where the file cache lives: { type: 'redis' } puts it on REDIS_URL
  // under each open's own key prefix. Only the ram opener consults it;
  // main.ts refuses it on any other VFS.
  cache?: { type?: string }
  // The env plane fixture this target declares: 'healthy' registers the
  // counting fake source and builds the managed env block, 'dead' a
  // source whose every fetch fails. Only the ram opener consults it;
  // main.ts refuses it on any other VFS.
  secrets?: string
  clis?: string[]
  // Scope an installed account CLI to this mount's folder, so the CLI and
  // the mount are pointed at the same place.
  cli_scope?: string
  // The target's profiles (`profiles:` in YAML). A profile is the whole
  // permission document a session runs under, per-mount rules included;
  // validated by the parser the YAML loader uses.
  profiles?: Record<string, unknown>
  // Which profile shapes a session that names none, its own included.
  profile?: string
  mounts: Mount[]
  // Sessions a case can name via its `session` field, through the two
  // entry points a host really has. A string names one of the target's profiles,
  // which is the whole document that session runs under. A mapping is
  // an inline document added to the default profile: it may add ask and
  // deny rules and hides, never an allow list, so a session that needs
  // its own allow list has to be a profile. An empty mapping is the
  // default profile with nothing added.
  sessions?: Record<string, string | Record<string, unknown> | null>
  // Session environment every case on this target runs under. The
  // conformance runner passes the same map to the real binary, so a CLI
  // option that reads a variable is compared under one environment.
  env?: Record<string, string>
}

export function integRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * Reject a target whose `exclusive` is not a boolean.
 *
 * The twin of the `shared` check in `loadServices`, and for the same reason:
 * one file is read by two hosts, and a hand-edited `"exclusive": 1` would run
 * the target alone on python and pool it here. That is the failure this key
 * exists to prevent, arriving as a typescript-only flake rather than as a
 * manifest error.
 */
export function validateTargets(targets: Target[]): Target[] {
  for (const target of targets) {
    if ('exclusive' in target && typeof target.exclusive !== 'boolean') {
      throw new Error(
        `targets.json: target '${target.id}' declares 'exclusive' as ${typeof target.exclusive}, must be a boolean`,
      )
    }
  }
  return targets
}

export function loadTargets(root: string): Map<string, Target> {
  const data = JSON.parse(readFileSync(join(root, 'targets.json'), 'utf8')) as {
    targets: Target[]
  }
  return new Map(validateTargets(data.targets).map((t) => [t.id, t]))
}

/**
 * The service -> per-host required env vars table.
 *
 * An empty list means the host needs nothing because its adapter starts an
 * in-process fake (or the backend needs no service). The two hosts differ per
 * service (python starts s3 and ssh itself where typescript reads an
 * endpoint; typescript needs nothing for quickjs where python reads
 * MIRAGE_QUICKJS_HOME), so each host's list is spelled out in targets.json
 * rather than inferred.
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
    const unknown = Object.keys(hosts)
      .filter((k) => !SERVICE_KEYS.has(k))
      .sort()
    if (unknown.length) {
      throw new Error(
        `targets.json: service '${name}' declares unknown key(s): ${unknown.join(', ')}`,
      )
    }
    // The value, not only the key. One file is read by two hosts, and python
    // reads `shared` for truth where this reads it for `=== true`, so a
    // hand-edited `"shared": 1` would serialize the lane there and pool it
    // here -- two targets on a one-world fake in flight together.
    if ('shared' in hosts && typeof hosts.shared !== 'boolean') {
      throw new Error(
        `targets.json: service '${name}' declares 'shared' as ${typeof hosts.shared}, must be a boolean`,
      )
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
      files = walkFiles(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
    } catch {
      continue
    }
    for (const file of files) {
      const rel = relative(root, file)
      const data = JSON.parse(readFileSync(file, 'utf8')) as {
        targets?: string[]
        cases: (Omit<Case, 'targets'> & { targets?: string[] })[]
      }
      for (const c of data.cases) {
        cases.push({ targets: data.targets ?? [], ...c, _source: rel })
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
 * anywhere, which reads as "passing" everywhere. A `mount_read` or a `write`
 * without a `read` is routed as an ordinary case, where the selector is never
 * applied.
 */
export function validateCases(root: string, cases: Case[]): void {
  const known = new Set(loadTargets(root).keys())
  const seen = new Map<string, string>()
  const duplicates: string[] = []
  const unknown: string[] = []
  for (const c of cases) {
    if (
      !Array.isArray(c.targets) ||
      c.targets.length === 0 ||
      c.targets.some((t) => typeof t !== 'string')
    ) {
      throw new Error(`case ${c.id}: targets must be a nonempty string list`)
    }
    if (c.mount_read !== undefined && c.read === undefined) {
      throw new Error(`case ${c.id}: mount_read needs read, the policy every other mount inherits`)
    }
    if (c.write !== undefined && c.read === undefined) {
      throw new Error(`case ${c.id}: write needs read, which routes a case to the scenario runner`)
    }
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

/**
 * The per-mount policies a scenario case overrides its default with. Each
 * named prefix runs under its own policy and every other mount inherits
 * `read`, the only way a case can put two policies on one line; `ttl`
 * bounds each.
 */
export function mountReadOf(c: Pick<Case, 'mount_read' | 'ttl'>): Record<string, ReadSpec> {
  const out: Record<string, ReadSpec> = {}
  for (const [prefix, policy] of Object.entries(c.mount_read ?? {})) {
    out[prefix] = resolveReadSpec(policy, c.ttl)
  }
  return out
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
    const dest = `${rstripSlash(mountPath)}/${rel}`
    const parent = dest.slice(0, dest.lastIndexOf('/'))
    await ws.shell(`mkdir -p ${parent}`)
    await ws.shell(`tee ${dest} > /dev/null`, { stdin: new Uint8Array(readFileSync(file)) })
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
  const marker = `${rstripSlash(mountPath)}/.seed`
  await ws.shell(`tee ${marker} > /dev/null`, { stdin: ENC.encode('seed\n') })
  await ws.shell(`rm ${marker}`)
}

/**
 * Why a path mutate step cannot run, or null when it can.
 *
 * Only `"delete": true` removes; anything else writes `content`, so a step
 * with neither a string content nor a true delete has nothing to write. A
 * delete that is not a boolean says neither. Mirrors Python's
 * `malformed_mutate`.
 */
export function malformedMutate(spec: Record<string, unknown>): string | null {
  const shown = JSON.stringify(spec)
  if ('delete' in spec && typeof spec.delete !== 'boolean') {
    return `malformed mutate step ${shown}: "delete" must be true or false`
  }
  if (spec.delete !== true && typeof spec.content !== 'string') {
    return `malformed mutate step ${shown}: "content" must be a string unless "delete" is true`
  }
  return null
}

export async function runScenario(
  ws: ExecWorkspace,
  mutate: (path: string, content: Uint8Array) => Promise<void>,
  remove: (path: string) => Promise<void>,
  mutateLine: (command: string) => Promise<void>,
  steps: ScenarioStep[],
): Promise<{ exitCode: number; out: string; err: string; notes: string[] }> {
  const outputs: string[] = []
  const errors: string[] = []
  const notes: string[] = []
  let exitCode = 0
  for (const step of steps) {
    if ('mutate' in step) {
      const spec = step.mutate
      if ('command' in spec) {
        await mutateLine(spec.command)
        continue
      }
      const refusal = malformedMutate(spec)
      if (refusal !== null) throw new Error(refusal)
      // Only `delete: true` removes; `false` is a plain mutate, as on python.
      if (spec.delete === true) await remove(spec.path)
      else await mutate(spec.path, ENC.encode(spec.content))
      continue
    }
    const result = await ws.shell(step.command)
    outputs.push(DEC.decode(result.stdout))
    errors.push(DEC.decode(result.stderr))
    notes.push(...undecodable({ stdout: result.stdout, stderr: result.stderr }))
    exitCode = result.exitCode
  }
  return { exitCode, out: outputs.join(''), err: errors.join(''), notes }
}

/** The two workspaces a consistency scenario runs across, and their teardown. */
export interface ScenarioOpen {
  ws: ExecWorkspace
  mutate: (path: string, content: Uint8Array) => Promise<void>
  remove: (path: string) => Promise<void>
  mutateLine: (command: string) => Promise<void>
  cleanup: () => Promise<void>
}

// Not an exit any case expects, so a scenario that never ran compares unequal
// to every golden instead of matching one by accident.
const NO_SHADOW_EXIT = 125

/**
 * Run one consistency scenario, or record why it could not run.
 *
 * A target a case names but whose adapter cannot build the shadow workspace is
 * a broken target, not an optional one, so it comes back as a failed result the
 * caller records like any other rather than a skip it prints and moves past.
 * Python's runner has no skip arm at all; this keeps the two hosts alike.
 *
 * Args:
 *   opener: builds the read workspace plus its shadow, or null when the
 *     adapter cannot.
 *   c: the case being run.
 *   target: the target it runs against.
 */
export async function runConsistencyCase(
  opener: () => Promise<ScenarioOpen | null>,
  c: Case,
  target: Target,
): Promise<{ exitCode: number; out: string; stderr: string; notes: string[] }> {
  const opened = await opener()
  if (opened === null) {
    return {
      exitCode: NO_SHADOW_EXIT,
      out: '',
      notes: [],
      stderr: `[${target.id}] ${c.id}: ${target.mounts[0]?.vfs ?? 'unknown'} adapter has no shadow workspace\n`,
    }
  }
  try {
    // Same rule as the ordinary path: a target's declared environment reaches
    // every workspace a case can run against, or a consistency scenario would
    // silently run under a different one.
    opened.ws.env = { ...opened.ws.env, ...(target.env ?? {}) }
    const { exitCode, out, err, notes } = await runScenario(
      opened.ws,
      opened.mutate,
      opened.remove,
      opened.mutateLine,
      c.scenario ?? [],
    )
    return { exitCode, out, stderr: err, notes }
  } finally {
    await opened.cleanup()
  }
}

export class Report {
  passed = 0
  failed = 0
  failures: string[] = []
  readonly lines: string[] = []

  /**
   * A concurrent run gives every target its own report and absorbs them in
   * the order the targets were selected, so the printed lines are the serial
   * run's lines whatever order the targets actually finished in. Streaming is
   * the default because a serial run should still report as it goes.
   */
  constructor(private readonly stream = true) {}

  record(target: string, caseId: string, diffs: string[]): void {
    let line: string
    if (diffs.length) {
      this.failed++
      const joined = diffs.join('; ')
      this.failures.push(`[${target}] ${caseId}: ${joined}`)
      line = `FAIL [${target}] ${caseId}: ${joined}`
    } else {
      this.passed++
      line = `ok   [${target}] ${caseId}`
    }
    if (this.stream) process.stdout.write(`${line}\n`)
    else this.lines.push(line)
  }

  /** Fold one target's buffered report into the run's, printing it. */
  absorb(other: Report): void {
    this.passed += other.passed
    this.failed += other.failed
    this.failures.push(...other.failures)
    for (const line of other.lines) process.stdout.write(`${line}\n`)
  }

  summary(): string {
    return `${String(this.passed)} passed, ${String(this.failed)} failed`
  }
}

/**
 * The lane a target holds for its whole run.
 *
 * Two targets in one lane are never in flight together. A lane is the SERVICE
 * only when that service is declared `shared`, because those fakes hold one
 * world: github serves every mount the same repository under one token, and
 * trello, discord and linear re-seed themselves from the fixture on connect.
 * Every other service mints a namespace per open -- gws a `/_run/<id>` path,
 * s3 a key prefix, gridfs a database, dropbox an account -- so its targets
 * cannot see each other and get a lane of their own. That distinction is the
 * whole speed of this: gws carries five core targets and s3 three, and they
 * are the slow ones.
 */
export function targetLane(target: Target, services: Map<string, ServiceEnv>): string {
  const service = target.service
  if (service === undefined) return `solo:${target.id}`
  const entry = services.get(service)
  // Thrown, not optional-chained past: python indexes the table and raises a
  // KeyError, and a manifest naming an undeclared service must not read here
  // as "not shared" and quietly pool.
  if (entry === undefined) throw new Error(`unknown service: ${service}`)
  return entry.shared === true ? service : `solo:${target.id}`
}

/**
 * Split eligible targets into the ones that run alone and the pool.
 *
 * A lane bounds a target against its own service's other targets; an
 * `exclusive` target is bounded against EVERY other target, because what it
 * touches is process-global rather than server-side: opfs replaces
 * `globalThis.navigator`, and the four `secrets-*` targets publish a fetch
 * function into the process-global source registry under a fixed name. Those
 * run first, one at a time, before the pool opens.
 *
 * Positions rather than entries, because the caller holds one output slot per
 * position: two `--target ram` on one line are two runs, and anything keyed by
 * the entry would merge one slot twice.
 */
export function planRun(
  targets: Target[],
  services: Map<string, ServiceEnv>,
): { alone: number[]; pool: { at: number; lane: string }[] } {
  const alone: number[] = []
  const pool: { at: number; lane: string }[] = []
  targets.forEach((t, at) => {
    if (t.exclusive === true) alone.push(at)
    else pool.push({ at, lane: targetLane(t, services) })
  })
  return { alone, pool }
}

export { ENC }
