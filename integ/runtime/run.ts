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

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { MongoClient } from 'mongodb'
import {
  buildRuntime,
  CLISpec,
  Limit,
  MongoDBResource,
  MountMode,
  PathSpec,
  RAMResource,
  RedisResource,
  registerRuntime,
  LINE_EXECUTOR,
  type LineExecutor,
  Runtime,
  S3Resource,
  ScriptSource,
  snakeToCamel,
  Workspace,
  type Action,
  type CommandContext,
  type ExecuteResultContext,
  type MountSpec,
  type OpsContext,
  type OpsResultContext,
  type Policy,
  type Resource,
  type RunResult,
  type RuntimeEntry,
} from '@struktoai/mirage-node'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'

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
  value?: unknown
}

interface FacadeSpec {
  method: string
  path: string
  data?: string
}

interface Step {
  command?: string
  runtime?: string
  stdin?: string
  add_runtime?: string
  s3_put?: { key: string; body: string }
  rename?: { src: string; dst: string }
  read_op?: string
  facade?: FacadeSpec
  expect?: Expect
}

interface MountSpecJson {
  resource: string
  files?: Record<string, string>
  limits?: Record<string, Record<string, unknown>>
}

interface CliSpecJson {
  script: string
  language?: string
  runtime?: string
  config?: Record<string, unknown>
}

interface World {
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
  world?: World
  build_error?: { contains: string }
  steps?: Step[]
}

interface Suite {
  suite: string
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

const RUNTIME_KINDS: Record<string, Parameters<typeof registerRuntime>[1]> = { echobox: EchoBox }

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
type HookName = 'preCommand' | 'preOps' | 'postOps' | 'postExecute'

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

async function buildResource(spec: MountSpecJson, runId: string): Promise<Resource> {
  if (spec.resource === 'ram') return new RAMResource()
  if (spec.resource === 'redis') {
    return new RedisResource({
      url: process.env.REDIS_URL ?? '',
      keyPrefix: `mirage-integ-runtime-ts-${runId}/`,
    })
  }
  if (spec.resource === 's3') {
    await ensureS3()
    return new S3Resource({
      bucket: BUCKET,
      region: 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minio',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minio123',
    })
  }
  if (spec.resource === 'mongodb') {
    await ensureMongo()
    return new MongoDBResource({ uri: process.env.MONGODB_URI ?? '', databases: [DB] })
  }
  throw new Error(`unknown resource kind: ${spec.resource}`)
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
  const mountSpecs = world.mounts ?? { '/ram': { resource: 'ram' } }
  for (const [prefix, spec] of Object.entries(mountSpecs)) {
    const resource = await buildResource(spec, runId)
    const guards = Object.fromEntries(
      Object.entries(spec.limits ?? {}).map(([cmd, kwargs]) => [
        cmd,
        new Limit(camelizeKeys(kwargs)),
      ]),
    )
    mounts[prefix] = Object.keys(guards).length > 0 ? [resource, MountMode.EXEC, guards] : resource
    for (const [name, content] of Object.entries(spec.files ?? {})) {
      seeds.push([prefix, name, content])
    }
  }
  const options: Record<string, unknown> = { mode: MountMode.EXEC }
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
    problems.push(`exit: expected ${expect.exit}, got ${exitCode}`)
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
  const problems: string[] = []
  for (const entry of expect.ops_contain ?? []) {
    if (!seen.includes(entry)) {
      problems.push(`ledger missing ${JSON.stringify(entry)}: got ${JSON.stringify(seen)}`)
    }
  }
  for (const entry of expect.ops_absent ?? []) {
    if (seen.includes(entry)) {
      problems.push(`ledger must not hold ${JSON.stringify(entry)}: got ${JSON.stringify(seen)}`)
    }
  }
  return problems
}

// One facade step: call a typed Ops convenience (`ws.fs`) and check its
// value. The JSON carries the python facade spelling (`is_dir`,
// `list_files`); snakeToCamel maps it onto the TS method.
async function runFacade(ws: Workspace, expect: Expect, spec: FacadeSpec): Promise<string[]> {
  const facade = ws.fs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  const method = facade[snakeToCamel(spec.method)]
  if (method === undefined) return [`facade has no method ${spec.method}`]
  const args: unknown[] = [spec.path]
  if (spec.data !== undefined) args.push(ENC.encode(spec.data))
  if (expect.errno !== undefined) {
    // The cross-language error assertion. `throws_contains` reads the
    // message, which the two languages word differently for the same
    // condition (python's OSError renders the strerror, the TypeScript
    // FsError carries only the path), so an errno case must name the
    // condition instead.
    let name = 'NONE'
    try {
      await method.apply(ws.fs, args)
    } catch (err) {
      name = (err as { code?: string }).code ?? (err as Error).constructor.name
    }
    if (name !== expect.errno) return [`facade errno ${name}, expected ${expect.errno}`]
    return []
  }
  if (expect.throws_contains !== undefined) {
    try {
      await method.apply(ws.fs, args)
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
  const value = await method.apply(ws.fs, args)
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

async function runStep(
  ws: Workspace,
  caseId: string,
  index: number,
  step: Step,
): Promise<string[]> {
  const expect = step.expect ?? {}
  const label = `step[${index}]`
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
  const command = step.command ?? ''
  const options: Record<string, unknown> = {}
  if (step.runtime !== undefined) options.runtime = step.runtime
  if (step.stdin !== undefined) options.stdin = ENC.encode(step.stdin)
  if (expect.throws_contains !== undefined) {
    try {
      await ws.execute(command, options)
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
  const result = await ws.execute(command, options)
  const stdout = DEC.decode(result.stdout)
  const stderr = DEC.decode(result.stderr)
  const problems = check(caseId, label, expect, result.exitCode, stdout, stderr)
  const seen = ws.records.slice(ledgerBefore).map((r) => `${r.op} ${r.path}`)
  problems.push(...checkOps(expect, seen).map((p) => `${caseId} ${label}: ${p}`))
  return problems
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
    for (const [index, step] of (testCase.steps ?? []).entries()) {
      problems.push(...(await runStep(ws, caseId, index, step)))
    }
  } finally {
    await ws.close()
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
  const files = readdirSync(SUITE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
  for (const file of files) {
    const suite = JSON.parse(readFileSync(join(SUITE_DIR, file), 'utf8')) as Suite
    if (only.size > 0 && !only.has(suite.suite)) continue
    const requires = suite.requires ?? {}
    const hostRequires = Array.isArray(requires) ? requires : (requires[HOST] ?? [])
    const unmet = hostRequires.filter((r) => !requirementMet(r))
    if (unmet.length > 0) {
      if (strict && suite.optional !== true) {
        failures.push(
          `${suite.suite}: unmet requirements ${unmet.join(', ')} (INTEG_RUNTIME_STRICT=1)`,
        )
        failed += 1
      } else {
        console.log(`skip ${suite.suite} (unmet: ${unmet.join(', ')})`)
        skipped += 1
      }
      continue
    }
    for (const testCase of suite.cases) {
      const hosts = testCase.hosts ?? ['python', 'typescript']
      if (!hosts.includes(HOST)) continue
      const problems = await runCase(suite.suite, testCase)
      if (problems.length > 0) {
        failed += 1
        failures.push(...problems)
        console.log(`FAIL ${suite.suite}/${testCase.id}`)
      } else {
        passed += 1
        console.log(`ok ${suite.suite}/${testCase.id}`)
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
