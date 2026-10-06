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

import { parseCommandLimits } from '@struktoai/mirage-core/policy/builtin/output_cap'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { MongoClient } from 'mongodb'
import type { FileEntryWithStats, SFTPWrapper } from 'ssh2'
import {
  buildRuntime,
  CLISpec,
  DiskVFS,
  Limit,
  MongoDBVFS,
  MountMode,
  PathSpec,
  RAMVFS,
  RedisVFS,
  registerRuntime,
  LINE_EXECUTOR,
  type LineExecutor,
  Runtime,
  S3VFS,
  ScriptSource,
  SSHVFS,
  snakeToCamel,
  Workspace,
  type Action,
  type CommandContext,
  type ExecuteResultContext,
  type MountSpec,
  type OpsContext,
  type OpsResultContext,
  type Policy,
  type RouteContext,
  type BaseVFS,
  type RunResult,
  type RuntimeEntry,
  type FilesystemOperation,
  type RegisteredOp,
} from '@struktoai/mirage-node'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import {
  EXTERNAL_COMMANDS,
  PROCESS_EXECUTOR,
  type ProcessExecution,
  type ProcessExecutor,
} from '@struktoai/mirage-core'
import type { RuntimeLanguage } from '@struktoai/mirage-core/runtime/types'
import type { RAMAccessor } from '@struktoai/mirage-core/accessor/ram'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { makeGenericCommands } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { IO as RAM_IO } from '@struktoai/mirage-core/commands/builtin/ram/io'

const HOST = 'typescript'
const SUITE_DIR = dirname(fileURLToPath(import.meta.url))
const DB = 'mirage_integ_runtime'
const BUCKET = 'mirage-integ-runtime-ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface Expect {
  exit?: number
  stdout?: string
  stdout_contains?: string
  stderr?: string
  stderr_contains?: string
  throws_contains?: string
  errno?: string
  content?: string
  ops_contain?: string[]
  ops_absent?: string[]
  ops_count?: Record<string, number>
  value?: unknown
  // An expect keyed by language, as `program` is: each language's own
  // answer for the step.
  python?: Expect
  js?: Expect
}

interface FacadeSpec {
  method: string
  path: string
  data?: string
  offset?: number
  length?: number
}

interface Step {
  command?: string | Record<string, string>
  script?: string | Record<string, string>
  // A guest program per language, run as `python3 -c` or `node -e`.
  program?: Record<string, string>
  runtime?: string
  stdin?: string
  add_runtime?: string
  s3_put?: { key: string; body: string }
  rename?: { src: string; dst: string }
  read_op?: string
  // What one backend answers differently, merged over `expect`.
  expect_on?: Record<string, Expect>
  facade?: FacadeSpec
  expect?: Expect
  // Steps run at once, each on a session of its own.
  parallel?: Step[]
}

interface MountSpecJson {
  vfs: string
  // The mount's MountMode value ("read", "write", "exec"); exec when absent.
  mode?: string
  // Set on a `backends` variant: the mount keeps its objects under a
  // prefix of its own, so variants never see each other's.
  scoped?: boolean
  files?: Record<string, string>
  generated_files?: number
  // Names, spelled as `files` spells them, whose stat and read fail the
  // way an upstream 5xx does while the listing still names them.
  failing?: string[]
  limits?: Record<string, Record<string, unknown>>
}

interface CliSpecJson {
  script: string
  language?: RuntimeLanguage
  runtime?: string
  config?: Record<string, unknown>
}

interface World {
  session_id?: string
  command_limits?: unknown
  register_runtimes?: Record<string, string>
  runtimes?: (string | Record<string, unknown>)[]
  route_policy?: string
  policies?: PolicySpec[]
  profiles?: Record<string, unknown>
  profile?: string
  mounts?: Record<string, MountSpecJson>
  clis?: Record<string, CliSpecJson>
}

interface PolicySpec {
  name: string
  sync?: boolean
  contains?: string
  runtime?: string
  deny?: string
  command?: string
  flag?: string
  reason?: string
  prefix?: string
  suffix?: string
  marker?: string
  max_bytes?: number
  max_lines?: number
  on_exceed?: string
}

interface Case {
  id: string
  hosts?: string[]
  runtimes?: string[]
  runtime?: string
  backends?: string[]
  backend?: string
  requires?: string[]
  optional?: boolean
  entry?: { captures?: string[]; config?: Record<string, unknown> }
  world?: World
  filesystem?: Record<string, Partial<Record<FilesystemOperation, boolean>>>
  build_error?: { contains: string }
  steps?: Step[]
}

interface Suite {
  requires?: string[] | Record<string, string[]>
  optional?: boolean
  cases: Case[]
}

let s3Seeded = false
let mongoSeeded = false

class EchoBox extends Runtime implements LineExecutor {
  readonly [LINE_EXECUTOR] = true as const
  readonly name = 'echobox'

  constructor(options = {}) {
    super(options, ['nvidia-smi'], [])
  }

  runLine(line: string): Promise<RunResult> {
    return Promise.resolve({
      stdout: ENC.encode(`box:${line}\n`),
      stderr: null,
      exitCode: 0,
    })
  }
}

// Registered the way a host registers its own runtime, so a case names
// it by string like a builtin, `buildRuntime` resolves it, and the
// unknown-name refusal lists it. The registry suite pins that door.
registerRuntime('echobox', EchoBox)

class ProcessBox extends Runtime implements ProcessExecutor {
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name = 'processbox'

  constructor(options = {}) {
    super(options, [EXTERNAL_COMMANDS], [])
  }

  runProcess(request: ProcessExecution): Promise<RunResult> {
    return Promise.resolve({
      stdout: ENC.encode(`${JSON.stringify(request.argv)}\n`),
      stderr: null,
      exitCode: 0,
    })
  }
}

const RUNTIME_KINDS: Record<string, Parameters<typeof registerRuntime>[1]> = {
  echobox: EchoBox,
  processbox: ProcessBox,
}

// The world's host-side runtime registrations, `name -> kind`, applied
// before the world's runtimes are built so a refused registration (a
// builtin's name) surfaces as the case's build error.
function registerRuntimes(entries: Record<string, string>): void {
  for (const [name, kind] of Object.entries(entries)) {
    const cls = RUNTIME_KINDS[kind]
    if (cls === undefined) throw new Error(`unknown runtime kind: ${kind}`)
    registerRuntime(name, cls)
  }
}

// Test-only policies, one per hook, mirroring the Python runner: the
// world's `policies` entries pick a class by `name` and carry its config.
// Each decides synchronously in `decide`; the hook the engine calls is
// stamped on per case, returning a promise (the default) or the value
// itself (`"sync": true`), so one case runs under both shapes on both
// hosts. The seam awaits whatever a hook returns, which is what let a
// plain `def` hook stop failing closed on the python side.
type HookName = 'preCommand' | 'preExecute' | 'preOps' | 'postOps' | 'postExecute'

interface TestPolicy<C> {
  readonly hook: HookName
  decide(ctx: C): Action | null
}

class DenyFlag implements TestPolicy<CommandContext> {
  readonly hook = 'preCommand'
  private readonly spec: PolicySpec
  constructor(spec: PolicySpec) {
    this.spec = spec
  }
  decide(ctx: CommandContext): Action | null {
    if (ctx.command === this.spec.command && ctx.argv.includes(this.spec.flag ?? '')) {
      return { kind: 'deny', reason: this.spec.reason ?? '' }
    }
    return null
  }
}

class PlaceLine implements TestPolicy<RouteContext> {
  readonly hook = 'preExecute'
  private readonly spec: PolicySpec
  constructor(spec: PolicySpec) {
    this.spec = spec
  }
  decide(ctx: RouteContext): Action | null {
    if (!ctx.line.includes(this.spec.contains ?? '')) return null
    if (this.spec.deny !== undefined) return { kind: 'deny', reason: this.spec.deny }
    return { kind: 'route', runtime: this.spec.runtime ?? '' }
  }
}

class LockWrites implements TestPolicy<OpsContext> {
  readonly hook = 'preOps'
  private readonly prefix: string
  constructor(spec: PolicySpec) {
    this.prefix = spec.prefix ?? ''
  }
  decide(ctx: OpsContext): Action | null {
    if (ctx.write && ctx.path.virtual.startsWith(this.prefix)) {
      return { kind: 'deny', reason: 'locked' }
    }
    return null
  }
}

class SealReads implements TestPolicy<OpsContext> {
  readonly hook = 'preOps'
  private readonly suffix: string
  constructor(spec: PolicySpec) {
    this.suffix = spec.suffix ?? ''
  }
  decide(ctx: OpsContext): Action | null {
    if (!ctx.write && ctx.path.virtual.endsWith(this.suffix)) {
      return { kind: 'deny', reason: 'sealed' }
    }
    return null
  }
}

class RedactReads implements TestPolicy<OpsResultContext> {
  readonly hook = 'postOps'
  private readonly marker: string
  constructor(spec: PolicySpec) {
    this.marker = spec.marker ?? ''
  }
  decide(ctx: OpsResultContext): Action | null {
    const data = ctx.result instanceof Uint8Array ? DEC.decode(ctx.result) : null
    if (ctx.op === 'read' && data !== null && data.includes(this.marker)) {
      return { kind: 'deny', reason: 'redacted' }
    }
    return null
  }
}

class OpReadCap implements TestPolicy<OpsResultContext> {
  readonly hook = 'postOps'
  private readonly suffix: string
  private readonly maxBytes: number
  constructor(spec: PolicySpec) {
    this.suffix = spec.suffix ?? ''
    this.maxBytes = spec.max_bytes ?? 0
  }
  decide(ctx: OpsResultContext): Action | null {
    if (ctx.op === 'read' && ctx.path.virtual.endsWith(this.suffix)) {
      return new Limit({ maxBytes: this.maxBytes })
    }
    return null
  }
}

class LineCap implements TestPolicy<ExecuteResultContext> {
  readonly hook = 'postExecute'
  private readonly limit: Limit
  constructor(spec: PolicySpec) {
    const { name: _name, sync: _sync, ...fields } = spec
    this.limit = new Limit(camelizeKeys(fields))
  }
  decide(_ctx: ExecuteResultContext): Action | null {
    return this.limit
  }
}

class Boom implements TestPolicy<ExecuteResultContext> {
  readonly hook = 'postExecute'
  constructor(_spec: PolicySpec) {}
  decide(_ctx: ExecuteResultContext): Action | null {
    throw new Error('boom')
  }
}

const POLICY_KINDS: Record<string, new (spec: PolicySpec) => TestPolicy<never>> = {
  deny_flag: DenyFlag,
  place_line: PlaceLine,
  lock_writes: LockWrites,
  seal_reads: SealReads,
  redact_reads: RedactReads,
  op_read_cap: OpReadCap,
  line_cap: LineCap,
  boom: Boom,
}

// The hook goes on the instance rather than a wrapper object so the
// fail-closed refusal still names the class (`policy Boom failed`).
function buildPolicy(spec: PolicySpec): Policy {
  const cls = POLICY_KINDS[spec.name]
  if (cls === undefined) throw new Error(`unknown policy kind: ${spec.name}`)
  const policy = new cls(spec)
  const decide = (ctx: never): Action | null => policy.decide(ctx)
  const hook =
    spec.sync === true
      ? decide
      : (ctx: never): Promise<Action | null> =>
          new Promise((resolve) => {
            resolve(decide(ctx))
          })
  return Object.assign(policy, { [policy.hook]: hook }) as unknown as Policy
}

function expand(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? '')
  }
  if (Array.isArray(value)) return value.map(expand)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)]))
  }
  return value
}

function requirementMet(req: string): boolean {
  if (req.startsWith('env:')) return Boolean(process.env[req.slice(4)])
  if (req === 's3') return Boolean(process.env.S3_ENDPOINT)
  throw new Error(`unknown requirement: ${req}`)
}

function s3Client(): S3Client {
  return new S3Client({
    region: 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minio',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minio123',
    },
  })
}

async function putS3(key: string, body: string): Promise<void> {
  const client = s3Client()
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }))
  client.destroy()
}

async function ensureS3(): Promise<void> {
  if (s3Seeded) return
  const client = s3Client()
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }))
  } catch {
    // bucket already exists from a prior run
  }
  client.destroy()
  await putS3('greeting.txt', 'hello from s3\n')
  s3Seeded = true
}

async function ensureMongo(): Promise<void> {
  if (mongoSeeded) return
  const client = new MongoClient(process.env.MONGODB_URI ?? '')
  try {
    await client.db(DB).dropDatabase()
    await client
      .db(DB)
      .collection('books')
      .insertMany([
        { _id: 1 as never, title: 'alpha' },
        { _id: 2 as never, title: 'beta' },
      ])
    await client
      .db(DB)
      .collection('authors')
      .insertMany([{ _id: 1 as never, name: 'ada' }])
  } finally {
    await client.close()
  }
  mongoSeeded = true
}

/**
 * A RAM mount whose named records fail their stat and read.
 *
 * The shape of one broken record behind a REST collection: the listing
 * names it, and every question about it errors with whatever the
 * upstream said, which is no filesystem code at all. The stat its
 * commands ask fails too, so ls and find meet the record where a remote
 * mount's commands do, and with no native find op, as such a mount has
 * none, find walks.
 */
class FailingRAMVFS extends RAMVFS {
  private readonly failing: ReadonlySet<string>

  constructor(failing: readonly string[]) {
    super()
    this.failing = new Set(failing)
  }

  override ops(): readonly RegisteredOp[] {
    return super
      .ops()
      .map((op) =>
        op.name === 'stat' || op.name === 'read' ? { ...op, fn: this.guard(op.fn) } : op,
      )
  }

  commands(): readonly RegisteredCommand[] {
    const { find: _find, ...io } = RAM_IO
    return makeGenericCommands<RAMAccessor>('ram', {
      ...io,
      stat: (accessor, path, index) => {
        if (this.failing.has(path.vfsPath.split('/').filter(Boolean).join('/'))) {
          return Promise.reject(new Error('upstream 502 Bad Gateway'))
        }
        return RAM_IO.stat(accessor, path, index)
      },
    })
  }

  private guard(fn: RegisteredOp['fn']): RegisteredOp['fn'] {
    return (accessor, path, args, kwargs) => {
      const name = path.vfsPath.split('/').filter(Boolean).join('/')
      if (this.failing.has(name)) return Promise.reject(new Error('upstream 502 Bad Gateway'))
      return fn(accessor, path, args, kwargs)
    }
  }
}

async function buildVfs(spec: MountSpecJson, runId: string): Promise<BaseVFS> {
  if (spec.vfs === 'ram') {
    const vfs = spec.failing !== undefined ? new FailingRAMVFS(spec.failing) : new RAMVFS()
    if (spec.generated_files !== undefined) {
      vfs.loadState({
        type: 'ram',
        files: Object.fromEntries(
          Array.from({ length: spec.generated_files }, (_, i) => [
            `/file-${String(i)}.txt`,
            ENC.encode('unused'),
          ]),
        ),
      })
    }
    return vfs
  }
  if (spec.vfs === 'disk') {
    return new DiskVFS({ root: mkdtempSync(join(tmpdir(), `mirage-integ-runtime-ts-${runId}-`)) })
  }
  if (spec.vfs === 'ssh') {
    // The ssh runtime's box: a fresh directory per mount, made before the
    // mount is, since a root that does not exist serves nothing.
    const root = `/tmp/mirage-integ-runtime-ts-${runId}`
    const username = process.env.MIRAGE_INTEG_SSH_USERNAME
    const identityFile = process.env.MIRAGE_INTEG_SSH_KEY
    const vfs = new SSHVFS({
      host: process.env.MIRAGE_INTEG_SSH_HOST ?? '',
      port: 2222,
      ...(username === undefined ? {} : { username }),
      ...(identityFile === undefined ? {} : { identityFile }),
      root,
    })
    const sftp = await vfs.accessor.sftp()
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(root, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    return vfs
  }
  if (spec.vfs === 'redis') {
    return new RedisVFS({
      url: process.env.REDIS_URL ?? '',
      keyPrefix: `mirage-integ-runtime-ts-${runId}/`,
    })
  }
  if (spec.vfs === 's3') {
    await ensureS3()
    return new S3VFS({
      ...(spec.scoped === true ? { keyPrefix: `mirage-integ-runtime-ts-${runId}/` } : {}),
      bucket: BUCKET,
      region: 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minio',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minio123',
    })
  }
  if (spec.vfs === 'mongodb') {
    await ensureMongo()
    return new MongoDBVFS({ uri: process.env.MONGODB_URI ?? '', databases: [DB] })
  }
  throw new Error(`unknown VFS kind: ${spec.vfs}`)
}

function camelizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [snakeToCamel(k), v]))
}

function buildEntry(entry: string | Record<string, unknown>): RuntimeEntry {
  if (typeof entry === 'string') return entry
  const options: Record<string, unknown> = {}
  if (entry.captures !== undefined) options.captures = entry.captures
  if (entry.config !== undefined) {
    // The JSON carries Python's snake_case config keys; the TS config
    // classes use camelCase, the same normalization the server yaml
    // loader applies.
    options.config = camelizeKeys(expand(entry.config) as Record<string, unknown>)
  }
  if (entry.script !== undefined) options.script = new ScriptSource(entry.script as string)
  return buildRuntime(entry.name as string, options)
}

async function buildWorkspace(world: World, runId: string): Promise<Workspace> {
  registerRuntimes(world.register_runtimes ?? {})
  const mounts: Record<string, MountSpec> = {}
  const seeds: [string, string, string][] = []
  const mountSpecs = world.mounts ?? { '/ram': { vfs: 'ram' } }
  for (const [index, [prefix, spec]] of Object.entries(mountSpecs).entries()) {
    const vfs = await buildVfs(spec, `${runId}-${index}`)
    const guards = Object.fromEntries(
      Object.entries(spec.limits ?? {}).map(([cmd, kwargs]) => [
        cmd,
        new Limit(camelizeKeys(kwargs)),
      ]),
    )
    const mode = (spec.mode ?? MountMode.EXEC) as MountMode
    mounts[prefix] =
      Object.keys(guards).length > 0 || spec.mode !== undefined ? [vfs, mode, guards] : vfs
    for (const [name, content] of Object.entries(spec.files ?? {})) {
      seeds.push([prefix, name, content])
    }
  }
  const options: Record<string, unknown> = {
    mode: MountMode.EXEC,
    commandLimits: parseCommandLimits(world.command_limits),
  }
  if (world.session_id !== undefined) options.sessionId = world.session_id
  if (world.runtimes !== undefined) options.runtimes = world.runtimes.map(buildEntry)
  if (world.route_policy !== undefined) options.routePolicy = new ScriptSource(world.route_policy)
  if (world.policies !== undefined) options.policies = world.policies.map(buildPolicy)
  if (world.profiles !== undefined) {
    options.profiles = Object.fromEntries(
      Object.entries(world.profiles).map(([name, doc]) => [
        name,
        parseSessionProfile(doc, `profile \`${name}\``),
      ]),
    )
  }
  if (world.profile !== undefined) options.profile = world.profile
  const ws = new Workspace(mounts, options)
  // The world's script CLIs, the yaml `clis:` shape inline: each entry
  // embeds its program instead of naming a file, the same way a runtime
  // entry embeds a policy script here; cli.sh writes them back out to
  // files to drive the yaml path.
  for (const [name, entry] of Object.entries(world.clis ?? {})) {
    const spec = new CLISpec({
      name,
      script: new ScriptSource(entry.script, entry.language ?? 'python'),
      ...(entry.runtime !== undefined ? { runtime: entry.runtime } : {}),
    })
    ws.registerCli(name, spec, entry.config ?? null)
  }
  const madeDirs = new Set<string>()
  for (const [prefix, name, content] of seeds) {
    // A nested seed needs its directory first: write refuses a missing
    // parent (GNU dest-parent semantics), and the op-level mkdir
    // creates the whole chain.
    const slash = name.lastIndexOf('/')
    if (slash > 0) {
      const dir = `${prefix}/${name.slice(0, slash)}`
      if (!madeDirs.has(dir)) {
        await ws.dispatch('mkdir', dir, [])
        madeDirs.add(dir)
      }
    }
    await ws.dispatch('write', `${prefix}/${name}`, [ENC.encode(content)])
  }
  return ws
}

function check(
  caseId: string,
  label: string,
  expect: Expect,
  exitCode: number,
  stdout: string,
  stderr: string,
): string[] {
  const problems: string[] = []
  if (expect.exit !== undefined && exitCode !== expect.exit) {
    problems.push(
      `exit: expected ${expect.exit}, got ${exitCode} (stderr ${JSON.stringify(stderr.slice(-300))})`,
    )
  }
  if (expect.stdout !== undefined && stdout !== expect.stdout) {
    problems.push(
      `stdout: expected ${JSON.stringify(expect.stdout)}, got ${JSON.stringify(stdout)}`,
    )
  }
  if (expect.stdout_contains !== undefined && !stdout.includes(expect.stdout_contains)) {
    problems.push(
      `stdout missing ${JSON.stringify(expect.stdout_contains)}: got ${JSON.stringify(stdout)}`,
    )
  }
  if (expect.stderr !== undefined && stderr !== expect.stderr) {
    problems.push(
      `stderr: expected ${JSON.stringify(expect.stderr)}, got ${JSON.stringify(stderr)}`,
    )
  }
  if (expect.stderr_contains !== undefined && !stderr.includes(expect.stderr_contains)) {
    problems.push(
      `stderr missing ${JSON.stringify(expect.stderr_contains)}: got ${JSON.stringify(stderr)}`,
    )
  }
  return problems.map((p) => `${caseId} ${label}: ${p}`)
}

function checkOps(expect: Expect, seen: string[]): string[] {
  const recorded = new Set([...seen, ...seen.map((entry) => entry.split(' ', 1)[0])])
  const problems: string[] = []
  for (const entry of expect.ops_contain ?? []) {
    if (!recorded.has(entry)) {
      problems.push(`ledger missing ${JSON.stringify(entry)}: got ${JSON.stringify(seen)}`)
    }
  }
  for (const entry of expect.ops_absent ?? []) {
    if (recorded.has(entry)) {
      problems.push(`ledger must not hold ${JSON.stringify(entry)}: got ${JSON.stringify(seen)}`)
    }
  }
  for (const [entry, want] of Object.entries(expect.ops_count ?? {})) {
    const got = seen.filter((s) => s === entry || s.split(' ', 1)[0] === entry).length
    if (got !== want) {
      problems.push(
        `ledger holds ${JSON.stringify(entry)} ${String(got)} times, not ${String(want)}: got ${JSON.stringify(seen)}`,
      )
    }
  }
  return problems
}

// One facade step: call a typed Ops convenience (`ws.vfs`) and check its
// value. The JSON carries the python facade spelling (`is_dir`,
// `list_files`); snakeToCamel maps it onto the TS method.
async function runFacade(ws: Workspace, expect: Expect, spec: FacadeSpec): Promise<string[]> {
  const facade = ws.vfs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const method = facade[snakeToCamel(spec.method)]
  if (method === undefined) return [`facade has no method ${spec.method}`]
  const args: unknown[] = [spec.path]
  if (spec.data !== undefined) args.push(ENC.encode(spec.data))
  if (spec.offset !== undefined) args.push(spec.offset)
  if (spec.length !== undefined) args.push(spec.length)
  if (expect.errno !== undefined) {
    // The cross-language error assertion. `throws_contains` reads the
    // message, which the two languages word differently for the same
    // condition (python's OSError renders the strerror, the TypeScript
    // FsError carries only the path), so an errno case must name the
    // condition instead.
    let name = 'NONE'
    try {
      await method.apply(ws.vfs, args)
    } catch (err) {
      name = (err as { code?: string }).code ?? (err as Error).constructor.name
    }
    if (name !== expect.errno) return [`facade errno ${name}, expected ${expect.errno}`]
    return []
  }
  if (expect.throws_contains !== undefined) {
    try {
      await method.apply(ws.vfs, args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(expect.throws_contains)) return []
      return [
        `facade raised ${JSON.stringify(message)}, expected ` +
          `${JSON.stringify(expect.throws_contains)} in the message`,
      ]
    }
    return ['facade: expected an error, none raised']
  }
  const value = await method.apply(ws.vfs, args)
  if (
    expect.value !== undefined &&
    JSON.stringify(value ?? null) !== JSON.stringify(expect.value)
  ) {
    return [
      `facade value ${JSON.stringify(value ?? null)}, expected ${JSON.stringify(expect.value)}`,
    ]
  }
  return []
}

/**
 * Run each branch on a session of its own, all at once. The branches
 * start together, so their ops reach the mounts interleaved as two
 * agents' would, and each is checked against its own `expect`. A branch
 * cannot check the ledger: the workspace keeps one, and every branch's
 * ops land in it. Mirrors run.py `_run_parallel`.
 */
async function runParallel(
  ws: Workspace,
  caseId: string,
  index: number,
  branches: Step[],
): Promise<string[]> {
  const ledger = branches.flatMap((branch, k) =>
    Object.keys(branch.expect ?? {}).some((key) => LEDGER_CHECKS.has(key))
      ? [
          `${caseId} step[${index}].parallel[${k}]: a branch cannot check ` +
            "the ledger, which holds every branch's ops",
        ]
      : [],
  )
  if (ledger.length > 0) return ledger
  const runs = branches.map((branch, k) => {
    const sessionId = `parallel-${index}-${k}`
    ws.createSession(sessionId)
    return runStep(ws, caseId, `step[${index}].parallel[${k}]`, branch, sessionId)
  })
  return (await Promise.all(runs)).flat()
}

async function runStep(
  ws: Workspace,
  caseId: string,
  label: string,
  step: Step,
  sessionId?: string,
): Promise<string[]> {
  const expect = step.expect ?? {}
  // The ledger slice this step adds: ws.records delegates to the Ops
  // facade's account, so the step's own ops are the tail.
  const ledgerBefore = ws.records.length
  if (step.facade !== undefined) {
    const problems = await runFacade(ws, expect, step.facade)
    const seen = ws.records.slice(ledgerBefore).map((r) => `${r.op} ${r.path}`)
    problems.push(...checkOps(expect, seen))
    return problems.map((p) => `${caseId} ${label}: ${p}`)
  }
  if (step.s3_put !== undefined) {
    await putS3(step.s3_put.key, step.s3_put.body)
    return []
  }
  if (step.add_runtime !== undefined) {
    ws.addRuntime(step.add_runtime)
    return []
  }
  if (step.rename !== undefined) {
    let errnoName = 'NONE'
    try {
      await ws.dispatch('rename', step.rename.src, [PathSpec.fromStrPath(step.rename.dst)])
    } catch (err) {
      errnoName = (err as { code?: string }).code ?? 'NONE'
    }
    if (errnoName !== (expect.errno ?? 'NONE')) {
      return [`${caseId} ${label}: rename errno ${errnoName}, expected ${expect.errno}`]
    }
    return []
  }
  if (step.read_op !== undefined) {
    // Reads through the op door (the surface FUSE and programmatic
    // access share), where preOps/postOps policies fire.
    let errnoName = 'NONE'
    let content = ''
    try {
      const result = await ws.dispatch('read', step.read_op, [])
      content = DEC.decode(result as Uint8Array)
    } catch (err) {
      errnoName = (err as { code?: string }).code ?? 'NONE'
    }
    const problems: string[] = []
    if (errnoName !== (expect.errno ?? 'NONE')) {
      problems.push(`read_op errno ${errnoName}, expected ${expect.errno ?? 'NONE'}`)
    }
    if (expect.content !== undefined && content !== expect.content) {
      problems.push(
        `read_op content ${JSON.stringify(content)}, expected ${JSON.stringify(expect.content)}`,
      )
    }
    return problems.map((p) => `${caseId} ${label}: ${p}`)
  }
  let command = step.command ?? ''
  if (typeof step.script === 'string') {
    const source = readFileSync(join(SUITE_DIR, '../fixtures/runtime', step.script), 'utf8')
    command += ' ' + singleQuote(source)
  }
  const options: Record<string, unknown> = {}
  if (sessionId !== undefined) options.sessionId = sessionId
  if (step.runtime !== undefined) options.runtime = step.runtime
  if (step.stdin !== undefined) options.stdin = ENC.encode(step.stdin)
  if (expect.throws_contains !== undefined) {
    try {
      await ws.shell(command, options)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(expect.throws_contains)) return []
      return [
        `${caseId} ${label}: raised ${JSON.stringify(message)}, expected ` +
          `${JSON.stringify(expect.throws_contains)} in the message`,
      ]
    }
    return [`${caseId} ${label}: expected an error, none raised`]
  }
  const result = await ws.shell(command, options)
  const stdout = DEC.decode(result.stdout)
  const stderr = DEC.decode(result.stderr)
  const problems = check(caseId, label, expect, result.exitCode, stdout, stderr)
  const seen = ws.records.slice(ledgerBefore).map((r) => `${r.op} ${r.path}`)
  problems.push(...checkOps(expect, seen).map((p) => `${caseId} ${label}: ${p}`))
  return problems
}

// What a case's `backends` entry needs on this host before it can run.
const BACKEND_REQUIRES: Record<string, string[]> = {
  ram: [],
  disk: [],
  ssh: ['env:MIRAGE_INTEG_SSH_HOST'],
  redis: ['env:REDIS_URL'],
  s3: ['s3'],
}
// The guest language of every runtime a case's `runtimes` may name, and
// the line head a step's program runs under in it. A sandbox has none: it
// runs whole lines, so a case's plain commands are its program.
const RUNTIME_LANGUAGE: Record<string, string | null> = {
  monty: 'python',
  wasi: 'python',
  pyodide: 'python',
  quickjs: 'js',
  local: 'python',
  sandlock: 'python',
  docker: null,
  ssh: null,
  e2b: null,
  smolvm: null,
  apple_container: null,
}
const PROGRAM_HEAD: Record<string, string> = { python: 'python3 -c', js: 'node -e' }
// The expect keys that read the workspace's op ledger.
const LEDGER_CHECKS = new Set(['ops_contain', 'ops_absent', 'ops_count'])
// What a `runtimes` entry needs on this host before it can run. A runtime
// missing here does not exist on this host (wasi is python's), so its
// variant is not listed at all. e2b is left out: E2B's sandbox proxy drops
// the JS SDK's command streams now and then (see the README).
const RUNTIME_REQUIRES: Record<string, string[]> = {
  monty: [],
  pyodide: [],
  quickjs: [],
  local: [],
  sandlock: ['env:MIRAGE_INTEG_SANDLOCK'],
  docker: ['env:MIRAGE_INTEG_DOCKER_CONTAINER'],
  ssh: ['env:MIRAGE_INTEG_SSH_HOST'],
  smolvm: ['env:MIRAGE_INTEG_SMOLVM_MACHINE'],
  apple_container: ['env:MIRAGE_INTEG_APPLE_CONTAINER'],
}
// The world entry a runtime is built from, before a case's own `entry`
// narrows its captures or adds config. Mirrors run.py RUNTIME_ENTRY.
const RUNTIME_ENTRY: Record<string, { captures?: string[]; config?: Record<string, unknown> }> = {
  sandlock: { captures: ['python3', 'node', '@external'] },
  docker: { captures: ['*'], config: { container: '${MIRAGE_INTEG_DOCKER_CONTAINER}' } },
  ssh: {
    captures: ['*'],
    config: {
      host: '${MIRAGE_INTEG_SSH_HOST}',
      port: 2222,
      username: '${MIRAGE_INTEG_SSH_USERNAME}',
      identity_file: '${MIRAGE_INTEG_SSH_KEY}',
    },
  },
  e2b: { captures: ['*'], config: { sandbox_id: '${MIRAGE_INTEG_E2B_SANDBOX}' } },
  smolvm: { captures: ['*'], config: { machine: '${MIRAGE_INTEG_SMOLVM_MACHINE}' } },
  apple_container: {
    captures: ['*'],
    config: { container: '${MIRAGE_INTEG_APPLE_CONTAINER}' },
  },
}
// Runtimes that need a host the hosted runners do not give every job: an
// unmet requirement skips their variants even under INTEG_RUNTIME_STRICT.
const OPTIONAL_RUNTIMES = new Set(['sandlock', 'e2b', 'smolvm', 'apple_container'])

/** The world entry for one runtime of a case's matrix. Mirrors run.py `_entry`. */
function runtimeEntry(
  runtime: string,
  override: { captures?: string[]; config?: Record<string, unknown> },
): string | Record<string, unknown> {
  const base = RUNTIME_ENTRY[runtime] ?? {}
  if (Object.keys(base).length === 0 && Object.keys(override).length === 0) return runtime
  const entry: Record<string, unknown> = { name: runtime, ...base, ...override }
  if (base.config !== undefined || override.config !== undefined) {
    entry.config = { ...base.config, ...override.config }
  }
  return entry
}

/**
 * The step with its `expect_on` entries for `keys` laid over `expect` in
 * order, a parallel step's branches each the same way. Mirrors run.py
 * `_overlay`.
 */
function overlay(step: Step, keys: string[]): Step {
  const on = step.expect_on ?? {}
  let expect: Expect = { ...(step.expect ?? {}) }
  for (const key of keys) expect = { ...expect, ...on[key] }
  const overlaid: Step = { ...step, expect }
  if (step.parallel !== undefined) overlaid.parallel = step.parallel.map((b) => overlay(b, keys))
  return overlaid
}

/**
 * One step as a runtime of `language` runs it, and whether it holds a
 * guest program; null when nothing in it runs there. A `program` (inline
 * source) or `script` (a fixture path) maps a guest language to what that
 * language runs, under `python3 -c` or `node -e`, and a `command` map
 * gives the whole line per language. An `expect` keyed by language, as
 * `program` is, gives each language its own answer. A parallel step keeps
 * the branches that run there. Mirrors run.py `_step_for`.
 */
function stepFor(step: Step, language: string | null): [Step | null, boolean] {
  if (step.parallel !== undefined) {
    const mapped = step.parallel.map((branch) => stepFor(branch, language))
    const branches = mapped.flatMap(([branch]) => (branch === null ? [] : [branch]))
    if (branches.length === 0) return [null, false]
    return [{ ...step, parallel: branches }, mapped.some(([, guest]) => guest)]
  }
  const key = (['program', 'script', 'command'] as const).find((k) => typeof step[k] === 'object')
  if (key === undefined) return [step, false]
  const source = language === null ? undefined : (step[key] as Record<string, string>)[language]
  if (language === null || source === undefined) return [null, false]
  const head = PROGRAM_HEAD[language] ?? ''
  const rest = { ...step }
  delete rest.program
  const mapped: Step =
    key === 'program'
      ? { ...rest, command: `${head} ${singleQuote(source)}` }
      : key === 'script'
        ? { ...rest, command: head, script: source }
        : { ...rest, command: source }
  const expect = step.expect ?? {}
  if (Object.keys(expect).some((k) => k in PROGRAM_HEAD)) {
    mapped.expect = (expect as Record<string, Expect | undefined>)[language] ?? {}
  }
  return [mapped, true]
}

/**
 * The case as one runtime runs it, or null when nothing runs there. Each
 * step runs as `stepFor` maps it to the runtime's language; a step with
 * nothing in that language is left out, and a case left with no program
 * is not the runtime's. A step's `expect_on` keyed by the runtime, then
 * by `runtime@host`, is what it answers differently, and the case's
 * `filesystem` entry for it is the capabilities it declares. Mirrors
 * run.py `_for_runtime`.
 */
function forRuntime(testCase: Case, runtime: string): Case | null {
  const language = RUNTIME_LANGUAGE[runtime] ?? null
  const steps: Step[] = []
  let programs = 0
  for (const listed of testCase.steps ?? []) {
    const [step, guest] = stepFor(listed, language)
    if (step === null) continue
    if (guest) programs += 1
    steps.push(overlay(step, [runtime, `${runtime}@${HOST}`]))
  }
  if (programs === 0 && language !== null) return null
  const world = structuredClone(testCase.world ?? {})
  world.runtimes = [runtimeEntry(runtime, testCase.entry ?? {}), 'workspace']
  return {
    ...testCase,
    id: `${testCase.id}@${runtime}`,
    runtime,
    world,
    steps,
    requires: [...(testCase.requires ?? []), ...(RUNTIME_REQUIRES[runtime] ?? [])],
    optional: OPTIONAL_RUNTIMES.has(runtime),
    filesystem: Object.fromEntries(
      Object.entries(testCase.filesystem ?? {}).filter(([name]) => name === runtime),
    ),
  }
}

/**
 * The case once per runtime and backend it names. `runtimes` pins that one
 * behavior holds whatever guest runs it (see `forRuntime`), `backends`
 * that it holds whatever serves the mount: each backend variant swaps the
 * RAM mounts for that backend, an S3 one under a prefix of its own. Each
 * variant takes its runtime's and backend's requirements. A step's
 * `expect_on` keyed by the backend, then by `runtime@backend`, holds what
 * that variant answers differently. Mirrors run.py `_variants`.
 */
function variants(testCase: Case): Case[] {
  if (testCase.runtimes === undefined) return backendVariants(testCase)
  const unknown = testCase.runtimes.filter((r) => RUNTIME_LANGUAGE[r] === undefined)
  if (unknown.length > 0) throw new Error(`${testCase.id}: unknown runtimes ${unknown.join(', ')}`)
  const only = new Set((process.env.INTEG_RUNTIMES ?? '').split(',').filter((r) => r !== ''))
  return testCase.runtimes
    .filter((runtime) => RUNTIME_REQUIRES[runtime] !== undefined)
    .filter((runtime) => only.size === 0 || only.has(runtime))
    .flatMap((runtime) => {
      const variant = forRuntime(testCase, runtime)
      return variant === null ? [] : backendVariants(variant)
    })
}

function backendVariants(testCase: Case): Case[] {
  if (testCase.backends === undefined) return [testCase]
  return testCase.backends.map((backend) => {
    const world = structuredClone(testCase.world ?? {})
    for (const spec of Object.values(world.mounts ?? {})) {
      if (spec.vfs === 'ram') {
        spec.vfs = backend
        spec.scoped = true
      }
    }
    return {
      ...testCase,
      id: `${testCase.id}@${backend}`,
      backend,
      world,
      requires: [
        ...(testCase.requires ?? []),
        ...(BACKEND_REQUIRES[backend] ?? [`unknown backend ${backend}`]),
      ],
    }
  })
}

// Remove the directory each disk and ssh backend mount was given; an ssh root
// goes over the mount's own connection, so this runs before the close.
async function removeRoots(ws: Workspace): Promise<void> {
  for (const entry of ws.mounts()) {
    const vfs = entry.vfs
    if (vfs instanceof DiskVFS) rmSync(vfs.root, { recursive: true })
    else if (vfs instanceof SSHVFS)
      await removeRemote(await vfs.accessor.sftp(), vfs.config.root ?? '/')
  }
}

async function removeRemote(sftp: SFTPWrapper, dir: string): Promise<void> {
  const entries = await new Promise<FileEntryWithStats[]>((resolveFn, rejectFn) => {
    sftp.readdir(dir, (err, list) => {
      if (err) rejectFn(err)
      else resolveFn(list)
    })
  })
  for (const entry of entries) {
    const path = `${dir}/${entry.filename}`
    if (entry.attrs.isDirectory()) {
      await removeRemote(sftp, path)
      continue
    }
    await new Promise<void>((resolveFn, rejectFn) => {
      sftp.unlink(path, (err) => {
        if (err) rejectFn(err)
        else resolveFn()
      })
    })
  }
  await new Promise<void>((resolveFn, rejectFn) => {
    sftp.rmdir(dir, (err) => {
      if (err) rejectFn(err)
      else resolveFn()
    })
  })
}

async function runCase(suite: string, testCase: Case): Promise<string[]> {
  const caseId = `${suite}/${testCase.id}`
  const world = testCase.world ?? {}
  const runId = Math.random().toString(16).slice(2, 10)
  if (testCase.build_error !== undefined) {
    let ws: Workspace
    try {
      ws = await buildWorkspace(world, runId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(testCase.build_error.contains)) return []
      return [
        `${caseId}: build raised ${JSON.stringify(message)}, expected ` +
          `${JSON.stringify(testCase.build_error.contains)} in the message`,
      ]
    }
    await ws.close()
    return [`${caseId}: expected the world build to fail`]
  }
  const ws = await buildWorkspace(world, runId)
  const problems: string[] = []
  try {
    for (const [name, operations] of Object.entries(testCase.filesystem ?? {})) {
      const runtime = ws.runtimes().find((entry) => entry.name === name)
      if (runtime === undefined) throw new Error(`Missing runtime ${name}`)
      const supported = new Set<string>(runtime.capabilities.filesystem)
      for (const [operation, expected] of Object.entries(operations)) {
        if (supported.has(operation) !== expected)
          problems.push(
            `${caseId}: ${name} filesystem ${operation}: expected ${expected}, got ${supported.has(operation)}`,
          )
      }
    }
    const backend = testCase.backend
    const keys = backend === undefined ? [] : [backend]
    if (backend !== undefined && testCase.runtime !== undefined) {
      keys.push(`${testCase.runtime}@${backend}`)
    }
    for (const [index, listed] of (testCase.steps ?? []).entries()) {
      const step = overlay(listed, keys)
      problems.push(
        ...(step.parallel !== undefined
          ? await runParallel(ws, caseId, index, step.parallel)
          : await runStep(ws, caseId, `step[${index}]`, step)),
      )
    }
  } finally {
    try {
      await removeRoots(ws)
    } finally {
      await ws.close()
    }
  }
  return problems
}

async function main(): Promise<number> {
  const only = new Set(process.argv.slice(2))
  const strict = process.env.INTEG_RUNTIME_STRICT === '1'
  let passed = 0
  let failed = 0
  let skipped = 0
  const failures: string[] = []
  const files = readdirSync(SUITE_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.split(sep).join('/'))
    .sort()
  for (const file of files) {
    const suite = JSON.parse(readFileSync(join(SUITE_DIR, file), 'utf8')) as Suite
    const name = file.slice(0, -'.json'.length)
    if (only.size > 0 && ![...only].some((o) => name === o || name.startsWith(`${o}/`))) continue
    const requires = suite.requires ?? {}
    const hostRequires = Array.isArray(requires) ? requires : (requires[HOST] ?? [])
    const unmet = hostRequires.filter((r) => !requirementMet(r))
    if (unmet.length > 0) {
      if (strict && suite.optional !== true) {
        failures.push(`${name}: unmet requirements ${unmet.join(', ')} (INTEG_RUNTIME_STRICT=1)`)
        failed += 1
      } else {
        console.log(`skip ${name} (unmet: ${unmet.join(', ')})`)
        skipped += 1
      }
      continue
    }
    for (const listed of suite.cases) {
      const hosts = listed.hosts ?? ['python', 'typescript']
      if (!hosts.includes(HOST)) continue
      for (const testCase of variants(listed)) {
        const unmetCase = (testCase.requires ?? []).filter((r) => !requirementMet(r))
        if (unmetCase.length > 0) {
          if (strict && testCase.optional !== true) {
            failures.push(
              `${name}/${testCase.id}: unmet requirements ${unmetCase.join(', ')} (INTEG_RUNTIME_STRICT=1)`,
            )
            failed += 1
          } else {
            console.log(`skip ${name}/${testCase.id} (unmet: ${unmetCase.join(', ')})`)
          }
          continue
        }
        const problems = await runCase(name, testCase)
        if (problems.length > 0) {
          failed += 1
          failures.push(...problems)
          console.log(`FAIL ${name}/${testCase.id}`)
        } else {
          passed += 1
          console.log(`ok ${name}/${testCase.id}`)
        }
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} suites skipped`)
  for (const line of failures) console.log(`  ${line}`)
  return failures.length > 0 ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
