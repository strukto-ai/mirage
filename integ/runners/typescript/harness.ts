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
import { Outcome, Scope } from '@struktoai/mirage-core/policy/index'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'

// integ/runtime holds the runtime suite (its own schema and runners,
// integ/runtime/run.{py,ts} + cli.sh), not battery cases; keep it out.
const CASE_DIRS = [
  'unix',
  'bash',
  'crossmount',
  'resources',
  'cli',
  'session',
  'console',
  'secrets',
]
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
  // The repository a repo-shaped mount names (github, hf_hub).
  repo?: string
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
  // Where background-job consoles live: { type: 'redis' } puts each
  // job's console on its own Redis stream (REDIS_URL). Only the ram
  // opener consults it; main.ts refuses it on any other resource.
  console?: { type?: string }
  // The env plane fixture this target declares: 'healthy' registers the
  // counting fake source and builds the managed env block, 'dead' a
  // source whose every fetch fails. Only the ram opener consults it;
  // main.ts refuses it on any other resource.
  secrets?: string
  clis?: string[]
  // Scope an installed account CLI to this mount's folder, so the CLI and
  // the mount are pointed at the same place.
  cli_scope?: string
  // The target's profiles (`profiles:` in YAML). A profile is the whole
  // permission document a session runs under, per-mount rules included;
  // validated by the parser the YAML door uses.
  profiles?: Record<string, unknown>
  // Which profile shapes a session that names none, its own included.
  profile?: string
  mounts: Mount[]
  // Sessions a case can name via its `session` field, through the two
  // doors a host really has. A string names one of the target's profiles,
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
  stat?: string
  fields?: string[]
  read?: string
  offset?: number
  size?: number | null
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
  // The host's answer to every approval waiting on the workspace, given
  // before the command runs: `allow_once`, `allow_session` or `deny`.
  // How a case exercises the ask arm, since the battery has no host of
  // its own.
  answer?: 'allow_once' | 'allow_session' | 'deny'
  // Why this case's verdict is out of reach of `ws.explain`, which reads
  // the command plane and the line as typed: a runtime-expanded glob, a
  // refusal from the op door below the gate, a function the same line
  // defines. Named rather than silently omitted.
  explain_blind?: string
  scenario?: ScenarioStep[]
  expect: Expect
  _source?: string
}

export type ScenarioStep = { mutate: { path: string; content: string } } | { command: string }

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

export interface ExplainRow {
  exitCode: number
  stderr: string
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
  dispatch(
    opName: string,
    path: string,
    args?: readonly unknown[],
    kwargs?: Record<string, unknown>,
  ): Promise<unknown>
  cache: { clear(): Promise<void> }
  mounts(): readonly { resource: { index?: { clear(): Promise<void> } } }[]
  createSession(
    sessionId: string,
    options: { profile?: string | SessionProfile; permissions?: SessionProfile },
  ): unknown
  env: Record<string, string>
  decisions: {
    pending(): readonly { id: string }[]
    answer(id: string, outcome: Outcome, scope?: Scope): Promise<void>
  }
  explain(line: string, sessionId?: string): Promise<readonly ExplainRow[]>
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
      files = walkFiles(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
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

/**
 * The probe a case runs beside its command, as one printable line.
 *
 * Two forms. `stat` names a path and the FileStat fields to print. `read`
 * names a path and a byte window, and prints what that window returned: no
 * shell command asks for one, because commands read whole files, so the
 * ranged read op is only reachable through the same door FUSE and the ops
 * facade use.
 */
export async function statCheck(ws: ExecWorkspace, check: StatCheck): Promise<string> {
  if (check.read !== undefined) {
    const data = (await ws.dispatch('read', check.read, [], {
      offset: check.offset ?? 0,
      size: check.size ?? null,
    })) as Uint8Array
    return new TextDecoder().decode(data)
  }
  let st: HarnessStat
  try {
    st = (await ws.dispatch('stat', check.stat ?? '')) as HarnessStat
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return 'absent\n'
    throw err
  }
  return (check.fields ?? []).map((name) => checkField(st, name)).join(' ') + '\n'
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
      c.expect.stderr.includes(token) ||
      c.check?.stat?.includes(token) === true ||
      c.check?.read?.includes(token) === true ||
      c.expect.check?.includes(token) === true,
  )
  if (!present) return c
  const check =
    c.check === undefined
      ? undefined
      : {
          ...c.check,
          ...(c.check.stat !== undefined ? { stat: subst(c.check.stat) } : {}),
          ...(c.check.read !== undefined ? { read: subst(c.check.read) } : {}),
        }
  return {
    ...c,
    ...(c.command !== undefined ? { command: subst(c.command) } : {}),
    ...(check !== undefined ? { check } : {}),
    expect: {
      ...c.expect,
      stdout: subst(c.expect.stdout),
      stderr: subst(c.expect.stderr),
      ...(c.expect.check !== undefined ? { check: subst(c.expect.check) } : {}),
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
/**
 * What each of the battery's words answers with. DENY is ONCE because a
 * refusal answers the one retry it was given for; a session-wide deny
 * would be a rule, which is the document's job and not a host's.
 */
const ANSWERS = new Map<string, readonly [Outcome, Scope]>([
  ['allow_once', [Outcome.ALLOW, Scope.ONCE]],
  ['allow_session', [Outcome.ALLOW, Scope.SESSION]],
  ['deny', [Outcome.DENY, Scope.ONCE]],
])

/**
 * The host's side of the ask arm: answer every approval waiting on the
 * workspace the way the case says, so the command that follows finds
 * the answer (or the refusal) the way an agent's retry would.
 *
 * The word is looked up before anything is answered, so a case that
 * misspells one fails loudly here. The literal union on `Case` is a
 * compile-time promise about a value that arrives from JSON, so it does
 * not reach this far on its own; without the lookup every word that was
 * not `allow_once` fell through to a session-wide allow, and a typo
 * passed the case while testing the most permissive answer there is.
 */
async function answerDecisions(ws: ExecWorkspace, answer: string): Promise<void> {
  const pair = ANSWERS.get(answer)
  if (pair === undefined) {
    throw new Error(`case answer must be one of ${[...ANSWERS.keys()].join(', ')}, got ${answer}`)
  }
  const [outcome, scope] = pair
  for (const record of ws.decisions.pending()) {
    await ws.decisions.answer(record.id, outcome, scope)
  }
}

/**
 * Every reason a document's rules can speak with.
 *
 * These are what a refusal the policy layer wrote looks like on the wire,
 * and they are distinctive enough ("sealed until review") to tell one
 * apart from an ordinary command failure, which is what `explainNotes`
 * needs to check the direction a prediction cannot check on its own.
 */
export function ruleReasons(doc: unknown): string[] {
  const found = new Set<string>()
  const stack: unknown[] = [doc]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      stack.push(...node)
    } else if (node !== null && typeof node === 'object') {
      const rec = node as Record<string, unknown>
      if (typeof rec['reason'] === 'string') found.add(rec['reason'])
      stack.push(...Object.values(rec))
    }
  }
  return [...found].sort()
}

/**
 * What `explain` says would refuse this line, null when it says the line
 * runs. The first refusal wins, because that is the one the run reports:
 * a line is refused by its first refusing command.
 */
async function predictedRefusal(ws: ExecWorkspace, c: Case): Promise<[number, string] | null> {
  const said = await ws.explain(c.command, c.session ?? '')
  for (const expl of said) {
    if (expl.exitCode !== 0) return [expl.exitCode, expl.stderr]
  }
  return null
}

/**
 * Where the dry run and the run disagreed, empty when they agree.
 *
 * Three properties, checked against every policy case rather than only
 * the unit tests, because each is a promise the whole surface makes and
 * none of them is visible in a golden.
 *
 * A dry run must record no question, or a host fields requests for lines
 * nobody typed. A refusal it predicts must be the refusal that arrives.
 * And the harder direction: a refusal that arrives must have been
 * predicted, which is checked by looking for one of the document's own
 * rule reasons in what the run printed. That last one is the direction a
 * prediction cannot check on its own, and it is where the bugs were:
 * reading a line without its redirect target answered ALLOW for a line
 * the run refused.
 *
 * The message is looked for on either stream because the line's own
 * redirections still apply to the run and not to the prediction:
 * `rm /denied 2>&1` is refused on stdout.
 */
export function explainNotes(
  predicted: [number, string] | null,
  recorded: number,
  exitCode: number,
  out: string,
  err: string,
  reasons: readonly string[],
): string[] {
  const notes: string[] = []
  if (recorded !== 0) {
    notes.push(`explain: recorded ${recorded} question(s), must record none`)
  }
  const spoke = reasons.find((r) => r !== '' && (err.includes(r) || out.includes(r)))
  if (predicted === null) {
    if (spoke !== undefined) {
      notes.push(`explain: said the line runs, but a rule refused it with ${JSON.stringify(spoke)}`)
    }
    return notes
  }
  const [code, text] = predicted
  if (code !== exitCode) notes.push(`explain: predicted exit ${code}, run exited ${exitCode}`)
  if (text !== '' && !err.includes(text) && !out.includes(text)) {
    notes.push(
      `explain: predicted stderr ${JSON.stringify(text)}, run wrote ${JSON.stringify(err)}`,
    )
  }
  return notes
}

export async function runCase(
  ws: ExecWorkspace,
  c: Case,
  reasons: readonly string[] = [],
): Promise<{
  exitCode: number
  out: string
  err: string
  elapsed: number
  checkOut: string | null
  notes: string[]
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
      notes: [],
    }
  }
  if (c.answer !== undefined) await answerDecisions(ws, c.answer)
  const checks = reasons.length > 0 && c.explain_blind === undefined
  let predicted: [number, string] | null = null
  let recorded = 0
  if (checks) {
    const before = ws.decisions.pending().length
    predicted = await predictedRefusal(ws, c)
    // Counted here, not after the run: the run records its own question,
    // and charging that to the dry run would fail every ask case.
    recorded = ws.decisions.pending().length - before
  }
  const result = await ws.execute(c.command, { sessionId: c.session })
  const elapsed = (performance.now() - start) / 1000
  const out = DEC.decode(result.stdout)
  const err = DEC.decode(result.stderr)
  const checkOut = c.check !== undefined ? await statCheck(ws, c.check) : null
  return {
    exitCode: result.exitCode,
    out,
    err,
    elapsed,
    checkOut,
    notes: checks ? explainNotes(predicted, recorded, result.exitCode, out, err, reasons) : [],
  }
}

export function compare(
  c: Case,
  exitCode: number,
  out: string,
  err: string,
  elapsed: number,
  checkOut: string | null = null,
  notes: readonly string[] = [],
): string[] {
  const diffs: string[] = [...notes]
  if (exitCode !== c.expect.exit) diffs.push(`exit: expected ${c.expect.exit}, got ${exitCode}`)
  if (out !== c.expect.stdout)
    diffs.push(`stdout: expected ${JSON.stringify(c.expect.stdout)}, got ${JSON.stringify(out)}`)
  if (err.replace(/\n+$/, '') !== c.expect.stderr.replace(/\n+$/, ''))
    diffs.push(`stderr: expected ${JSON.stringify(c.expect.stderr)}, got ${JSON.stringify(err)}`)
  if (c.check !== undefined && checkOut !== c.expect.check)
    diffs.push(`check: expected ${JSON.stringify(c.expect.check)}, got ${JSON.stringify(checkOut)}`)
  const bounds = c.expect.elapsed
  if (bounds !== undefined && (elapsed < bounds.min || elapsed > bounds.max))
    diffs.push(
      `elapsed: expected [${String(bounds.min)}, ${String(bounds.max)}], got ${elapsed.toFixed(3)}`,
    )
  return diffs
}

export interface Sample {
  target: string
  id: string
  elapsed: number
  verb: string
}

// The first real word of a command, ignoring leading `VAR=value` assignments.
// Only groups the profile, so a wrong guess costs a mislabeled row.
// A leading `NAME=value` assignment, where the value may be quoted or a
// parenthesised array. Splitting on whitespace instead cut `v='a b'` in half
// and recorded the fragment as the command.
const LEADING_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\([^)]*\)|\S*)\s*/
const LEADING_SEP = /^(?:;|&&|\|\||&)\s*/
// `out=$(cat <<END` is the command `cat`, but LEADING_ASSIGN ends at the space
// and leaves `<<END` as the first word. Tried before it, so its `\S*` arm
// never gets to swallow `$(cat`.
const LEADING_CMDSUB = /^(?:[A-Za-z_][A-Za-z0-9_]*=)?\$\(\s*/
// A subshell or brace group is a wrapper, not the command: `(cd d && grep x)`
// was recorded as `(cd`. Stripping the delimiter re-enters the loop, so
// `((echo a); echo b)` peels both. It does NOT make the row `grep`: knowing
// that `cd` is a prelude is shell semantics, and this labels a row rather
// than parsing a line.
const LEADING_GROUP = /^[({]\s*/

export function commandVerb(command: string): string {
  let rest = command.trim()
  for (;;) {
    const match =
      LEADING_CMDSUB.exec(rest) ??
      LEADING_GROUP.exec(rest) ??
      LEADING_ASSIGN.exec(rest) ??
      LEADING_SEP.exec(rest)
    if (match === null || match[0].length === 0) break
    rest = rest.slice(match[0].length)
  }
  const first = rest.split(/\s+/).filter((w) => w.length > 0)[0]
  return first === undefined ? '?' : first.replace(/^.*\//, '')
}

// A consistency case carries no `command`: its commands live in the scenario
// steps. Reading the field straight off it handed `commandVerb` undefined,
// which threw on `.trim()` and took the whole battery down.
export const SCENARIO_VERB = 'scenario'

// A scenario case is charged as `scenario`, not as its first step. The
// interval is the whole case, and a scenario spends it on out-of-band remote
// writes and more than one invocation, so billing it to the first verb made
// `cat` and `find` carry time no `cat` or `find` spent. A row of its own says
// what the time is; the slowest-cases table above it names an expensive one.
export function scenarioVerb(c: Case): string {
  if (typeof c.command === 'string') return c.command
  for (const step of c.scenario ?? []) {
    if ('command' in step) return SCENARIO_VERB
  }
  return ''
}

export class Report {
  passed = 0
  failed = 0
  failures: string[] = []
  // Held rather than printed when the run is concurrent, so lines can be
  // replayed in target order and a parallel run reads like a serial one.
  readonly held: string[] = []
  readonly samples: Sample[] = []
  // Wall time for the whole target, which the per-case samples cannot see:
  // opening it, seeding fixtures and cleaning up all sit outside `runCase`,
  // and on nextcloud the fixture seed alone is dozens of remote writes.
  readonly targetWall = new Map<string, number>()

  constructor(readonly stream: boolean = true) {}

  private say(line: string): void {
    if (this.stream) process.stdout.write(line)
    else this.held.push(line)
  }

  record(target: string, caseId: string, diffs: string[], elapsed = 0, command = ''): void {
    this.samples.push({ target, id: caseId, elapsed, verb: commandVerb(command) })
    if (diffs.length) {
      this.failed++
      const joined = diffs.join('; ')
      this.failures.push(`[${target}] ${caseId}: ${joined}`)
      this.say(`FAIL [${target}] ${caseId}: ${joined}\n`)
    } else {
      this.passed++
      this.say(`ok   [${target}] ${caseId}\n`)
    }
  }

  noteTargetWall(target: string, seconds: number): void {
    this.targetWall.set(target, (this.targetWall.get(target) ?? 0) + seconds)
  }

  absorb(other: Report): void {
    this.passed += other.passed
    this.failed += other.failed
    this.failures.push(...other.failures)
    this.samples.push(...other.samples)
    for (const [target, seconds] of other.targetWall) this.noteTargetWall(target, seconds)
    for (const line of other.held) process.stdout.write(line)
  }

  summary(): string {
    return `${String(this.passed)} passed, ${String(this.failed)} failed`
  }

  // Where the battery's wall clock goes. Local timings do not carry to CI
  // (docker on macOS is far slower per request), so this reports from inside
  // the CI job itself.
  profile(top = 15): string {
    if (this.samples.length === 0) return ''
    const secs = (n: number): string => (n >= 1 ? `${n.toFixed(1)}s` : `${(n * 1000).toFixed(0)}ms`)
    const at = (sorted: number[], q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
    const byTarget = new Map<string, number[]>()
    for (const s of this.samples) {
      const bucket = byTarget.get(s.target)
      if (bucket === undefined) byTarget.set(s.target, [s.elapsed])
      else bucket.push(s.elapsed)
    }
    // `wall` is the whole target, `cases` is only what the cases spent inside
    // it. The gap between them is setup and teardown: opening the target,
    // seeding its fixtures, hydrating sessions, and cleaning up.
    const out: string[] = ['', '=== profile: per target ===']
    out.push(
      [
        'target'.padEnd(22),
        'cases'.padStart(6),
        'wall'.padStart(9),
        'in cases'.padStart(9),
        'p50'.padStart(8),
        'p90'.padStart(8),
        'max'.padStart(9),
      ].join(' '),
    )
    const total = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
    // Ranked on wall, the column this table exists to show. Ranking on the
    // case total instead buried a target whose cost is setup: 100s of setup
    // and 1s of cases sorted below a target with 2s of cases.
    const wallOf = (t: string, raw: number[]): number => this.targetWall.get(t) ?? total(raw)
    for (const [target, raw] of [...byTarget.entries()].sort(
      (a, b) => wallOf(b[0], b[1]) - wallOf(a[0], a[1]),
    )) {
      const sorted = [...raw].sort((a, b) => a - b)
      out.push(
        [
          target.padEnd(22),
          String(raw.length).padStart(6),
          secs(this.targetWall.get(target) ?? total(raw)).padStart(9),
          secs(total(raw)).padStart(9),
          secs(at(sorted, 0.5)).padStart(8),
          secs(at(sorted, 0.9)).padStart(8),
          secs(sorted[sorted.length - 1]).padStart(9),
        ].join(' '),
      )
    }
    out.push('', `=== profile: ${String(top)} slowest cases ===`)
    for (const s of [...this.samples].sort((a, b) => b.elapsed - a.elapsed).slice(0, top)) {
      out.push(`  ${secs(s.elapsed).padStart(9)}  [${s.target}] ${s.id}`)
    }
    out.push('', `=== profile: ${String(top)} costliest commands ===`)
    const byVerb = new Map<string, { total: number; n: number }>()
    for (const s of this.samples) {
      const v = byVerb.get(s.verb) ?? { total: 0, n: 0 }
      v.total += s.elapsed
      v.n += 1
      byVerb.set(s.verb, v)
    }
    const ranked = [...byVerb.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, top)
    for (const [verb, v] of ranked) {
      out.push(
        `  ${secs(v.total).padStart(9)}  x${String(v.n).padEnd(5)} ` +
          `mean ${secs(v.total / v.n).padStart(8)}  ${verb}`,
      )
    }
    return out.join('\n')
  }
}

export { ENC }
