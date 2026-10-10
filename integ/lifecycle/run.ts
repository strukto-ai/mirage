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

import { isDeepStrictEqual } from 'node:util'
import { readFileSync } from 'node:fs'
import type { ShellExecution } from '@struktoai/mirage-core'
import {
  Workspace as NodeWorkspace,
  buildVfs as buildNodeVfs,
  registerVfsFactory as registerNodeVfs,
} from '@struktoai/mirage-node'
import {
  Workspace as BrowserWorkspace,
  buildVfs as buildBrowserVfs,
  registerVfsFactory as registerBrowserVfs,
} from '@struktoai/mirage-browser'
import { MountMode, type PathSpec } from '@struktoai/mirage-core/types'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import type {
  Workspace,
  WorkspaceOptions,
} from '@struktoai/mirage-core/workspace/workspace/workspace'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { classify } from '@struktoai/mirage-core/errors/classify'
import { ScriptSource } from '@struktoai/mirage-core/runtime/types'
import { Channel, JobConsole } from '@struktoai/mirage-core/shell/console/index'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import {
  Outcome,
  Scope,
  type Ask,
  type CommandContext,
  type CommandExplanation,
  type Deny,
  type VfsContext,
  type Route,
  type SessionContext,
  type ShellExplanation,
  type ShellNode,
  type VfsExplanation,
} from '@struktoai/mirage-core/policy/types'
import type { RouteContext } from '@struktoai/mirage-core/runtime/routing/types'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import { answered as answeredCall, checked } from '@struktoai/mirage-server/io_serde'
import { VFS_CALL_BY_NAME } from '@struktoai/mirage-server/vfs_calls'
import { CLI, CLIHandler, type CLIInvocation } from '@struktoai/mirage-core/commands/cli/types'
import { CommandSpec } from '@struktoai/mirage-core/commands/spec/types'
import { chunks } from '@struktoai/mirage-core/io/cooperative'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { sleep } from '@struktoai/mirage-core/utils/abort'
import type { CommandFnResult } from '@struktoai/mirage-core/commands/config'
import { runWithSession } from '@struktoai/mirage-core/context/session_context'
import { applyStateDict, toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import type { WorkspaceStateDict } from '@struktoai/mirage-core/workspace/snapshot/types'

interface ResourceConfig {
  vfs: string
  config?: Record<string, unknown>
}

interface Case {
  id: string
  settings: {
    mounts: Record<string, ResourceConfig>
    mode: MountMode
    profiles?: Record<string, unknown>
    runtimes?: string[]
  }
  steps: Step[]
}

type Step = (
  | ({ op: 'mount'; path: string; mode?: MountMode } & ResourceConfig)
  | { op: 'unmount' | 'read' | 'readdir' | 'stat' | 'cached' | 'stream_stats'; path: string }
  | { op: 'write'; path: string; data: string }
  | {
      op: 'exec'
      command: string
      session?: string
      cancel_after_ms?: number
      sink_delay_ms?: number
      env?: Record<string, string>
      cwd?: string
    }
  | { op: 'spawn'; argv: string[]; session?: string }
  | {
      op: 'stream_exec'
      command: string
      stop?: 'cancel' | 'close'
      consume_delay_ms?: number
    }
  | { op: 'set_mode'; path: string; mode: MountMode }
  | { op: 'session'; id: string; profile?: Record<string, unknown> }
  | { op: 'close_session'; id: string }
  | { op: 'set_profile'; session?: string; profile: Record<string, unknown> | string | null }
  | {
      op: 'register_cli'
      name: string
      script: ScriptDocument
      runtime?: string
      config?: Record<string, unknown>
    }
  | { op: 'unregister_cli' | 'add_runtime' | 'remove_runtime' | 'stream_cli_stats'; name: string }
  | {
      op: 'register_stream_cli'
      name: string
      exit_code?: number
      stderr?: string
    }
  | {
      op: 'register_policy'
      id: string
      commands?: string[]
      paths?: string[]
      vars?: string[]
      lines?: string[]
      routes?: Record<string, string>
      reason: string
    }
  | { op: 'tools' | 'asks' }
  | { op: 'tool'; tool: string; arguments: Record<string, unknown> }
  | { op: 'answer'; outcome?: Outcome; scope?: Scope }
  | { op: 'explain'; command: string }
  | { op: 'vfs'; call: string; args?: Record<string, unknown>; explain?: boolean }
  | { op: 'unregister_policy'; id: string }
  | {
      op: 'mounts' | 'clis' | 'runtimes' | 'close' | 'snapshot' | 'checkout' | 'drain_processes'
    }
  | { op: 'concurrent'; steps: Step[] }
) & { expect?: Record<string, unknown>; session?: string }

/** A host policy whose command and op refusals are supplied by JSON. Mirrors Python's `RulePolicy`. */
class RulePolicy implements Policy {
  constructor(
    private readonly rule: {
      commands?: string[]
      paths?: string[]
      vars?: string[]
      lines?: string[]
      routes?: Record<string, string>
      reason: string
    },
  ) {}

  preCommand(ctx: CommandContext): Deny | null {
    return this.rule.commands?.includes(ctx.command) === true
      ? { kind: 'deny', reason: this.rule.reason }
      : null
  }

  preVfs(ctx: VfsContext): Deny | null {
    return this.rule.paths?.includes(ctx.path.virtual) === true
      ? { kind: 'deny', reason: this.rule.reason }
      : null
  }

  preSession(ctx: SessionContext): Deny | null {
    return this.rule.vars?.includes(ctx.key) === true
      ? { kind: 'deny', reason: this.rule.reason }
      : null
  }

  preExecute(ctx: RouteContext): Deny | Route | null {
    if ((this.rule.lines ?? []).some((word) => ctx.line.includes(word))) {
      return { kind: 'deny', reason: this.rule.reason }
    }
    const routed = Object.entries(this.rule.routes ?? {}).find(([word]) => ctx.line.includes(word))
    return routed === undefined ? null : { kind: 'route', runtime: routed[1] }
  }
}

interface ScriptDocument {
  source: string
  language: 'python' | 'js'
}

function profileDocument(raw: Record<string, unknown>) {
  const doc = { ...raw }
  if (doc.policy != null) {
    const policy = doc.policy as { script: ScriptDocument; runtime: string }
    doc.policy = {
      ...policy,
      script: new ScriptSource(policy.script.source, policy.script.language),
    }
  }
  return parseSessionProfile(doc)
}

interface Host {
  name: string
  workspace: new (mounts: Record<string, BaseVFS>, options: WorkspaceOptions) => Workspace
  build: (name: string, config: Record<string, unknown>) => Promise<BaseVFS>
}

const HOSTS: Host[] = [
  { name: 'node', workspace: NodeWorkspace, build: buildNodeVfs },
  { name: 'browser', workspace: BrowserWorkspace, build: buildBrowserVfs },
]
const ENC = new TextEncoder()
const DEC = new TextDecoder()

class CachedRAMVFS extends RAMVFS {
  override readonly cachesReads = true
}

/** A chunked source whose pull and close counts are shared corpus assertions. */
class TrackedStreamVFS extends CachedRAMVFS {
  pulls = 0
  closed = 0

  constructor(
    private readonly chunkSize: number,
    private readonly failAfter?: number,
    private readonly stallAfter?: number,
  ) {
    super()
  }

  override async *readStream(
    path: PathSpec,
    index?: IndexCacheStore,
    signal?: AbortSignal,
  ): AsyncIterableIterator<Uint8Array> {
    const data = await super.read(path, index)
    try {
      for (let offset = 0; offset < data.byteLength; offset += this.chunkSize) {
        this.pulls++
        if (this.stallAfter !== undefined && offset / this.chunkSize >= this.stallAfter) {
          await sleep(Infinity, signal)
        }
        if (this.failAfter !== undefined && offset / this.chunkSize >= this.failAfter) {
          throw new Error('stream tail fetched')
        }
        yield data.subarray(offset, offset + this.chunkSize)
      }
    } finally {
      this.closed++
    }
  }
}

/** A registered CLI exercising stdin, deferred status, and producer closure. */
class TrackedStreamCLI {
  pulls = 0
  closed = 0

  constructor(
    readonly exitCode: number,
    readonly stderr: string,
  ) {}

  invoke(inv: CLIInvocation): CommandFnResult {
    const result = new IOResult({ stderr: ENC.encode(this.stderr) })
    return [this.output(inv, result), result]
  }

  async *output(inv: CLIInvocation, result: IOResult): AsyncIterableIterator<Uint8Array> {
    try {
      for await (const chunk of chunks(inv.stdin ?? new Uint8Array())) {
        this.pulls++
        yield chunk
      }
      result.exitCode = this.exitCode
    } finally {
      this.closed++
    }
  }
}

/** A caller streaming a line that takes a while over each chunk. */
class SlowSink extends JobConsole {
  constructor(readonly delayMs: number) {
    super()
  }

  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    await super.emit(channel, data)
  }
}

// Register a fixture through the same factory extension point as an embedder.
for (const register of [registerNodeVfs, registerBrowserVfs]) {
  register('tracked-stream', (config) => {
    const vfs = new TrackedStreamVFS(
      (config.chunk_size as number | undefined) ?? 16384,
      config.fail_after as number | undefined,
      config.stall_after as number | undefined,
    )
    const files = (config.files ?? {}) as Record<string, string>
    vfs.loadState({
      type: 'ram',
      files: Object.fromEntries(
        Object.entries(files).map(([path, data]) => [
          path,
          ENC.encode(data.repeat((config.repeat as number | undefined) ?? 1)),
        ]),
      ),
    })
    return Promise.resolve(vfs)
  })
  register('cached-ram', (config) => {
    const vfs = new CachedRAMVFS()
    const files = (config.files ?? {}) as Record<string, string>
    vfs.loadState({
      type: 'ram',
      files: Object.fromEntries(
        Object.entries(files).map(([path, data]) => [path, ENC.encode(data)]),
      ),
    })
    return Promise.resolve(vfs)
  })
}

/** Each policy answer as a case pins it: its kind, who gave it, and its reason or runtime. */
function answered(answers: readonly (Deny | Ask | Route)[]): Record<string, string>[] {
  return answers.map((a) => ({
    kind: a.kind,
    policy: a.policy ?? '',
    ...(a.kind === 'route' ? { runtime: a.runtime } : { reason: a.reason }),
  }))
}

/**
 * An explanation as a case pins it: a VFS call's verdict, or a line's with
 * its commands in the order the line reads them.
 */
function explained(expl: ShellExplanation | VfsExplanation): Record<string, unknown> {
  const verdict = {
    outcome: expl.outcome,
    reason: expl.reason,
    answers: answered(expl.answers),
    refusal: expl.refusal?.kind ?? null,
  }
  if ('call' in expl) return { call: expl.call, ...verdict, error: expl.error }
  return {
    ...verdict,
    exit_code: expl.exitCode,
    stderr: expl.stderr,
    commands: commandsOf(expl.node).map((c) => ({
      command: c.command,
      outcome: c.outcome,
      answers: answered(c.answers),
      runtime: c.runtime,
    })),
  }
}

/** Every command under a node of a line's tree, in source order. */
function commandsOf(node: ShellNode | CommandExplanation): CommandExplanation[] {
  const mine = 'command' in node ? [node] : []
  return [...mine, ...node.children.flatMap(commandsOf)]
}

// What earlier steps put aside for later ones: `snapshot` stores the
// state dict `checkout` applies.
interface Held {
  state?: WorkspaceStateDict
  streamClis?: Map<string, TrackedStreamCLI>
}

async function action(
  host: Host,
  ws: Workspace,
  step: Step,
  policies: Map<string, Policy>,
  held: Held,
): Promise<unknown> {
  if (['read', 'write', 'readdir', 'stat'].includes(step.op) && step.session !== undefined) {
    const { session, ...unbound } = step
    return runWithSession(ws.getSession(session), () => action(host, ws, unbound, policies, held))
  }
  switch (step.op) {
    case 'register_stream_cli': {
      const cli = new TrackedStreamCLI(step.exit_code ?? 0, step.stderr ?? '')
      held.streamClis ??= new Map()
      held.streamClis.set(step.name, cli)
      ws.registerCli(
        step.name,
        new CLI({
          spec: new CommandSpec({ name: step.name }),
          handlers: { '': new CLIHandler({ fn: (inv) => cli.invoke(inv) }) },
        }),
      )
      break
    }
    case 'stream_cli_stats': {
      const cli = held.streamClis?.get(step.name)
      if (cli === undefined) throw new Error('expected tracked stream CLI')
      return { pulls: cli.pulls, closed: cli.closed }
    }
    case 'stream_stats': {
      const vfs = ws.mount(step.path).vfs
      if (!(vfs instanceof TrackedStreamVFS)) throw new Error('expected tracked stream')
      return { pulls: vfs.pulls, closed: vfs.closed }
    }
    case 'cached': {
      const value = await ws.cache.get(step.path)
      return value === null ? null : DEC.decode(value)
    }
    case 'mount': {
      const vfs = await host.build(step.vfs, step.config ?? {})
      try {
        return ws.addMount(step.path, vfs, step.mode ?? MountMode.READ).prefix
      } catch (err) {
        await vfs.close()
        throw err
      }
    }
    case 'unmount':
      await ws.unmount(step.path)
      break
    case 'set_mode':
      ws.setMountMode(step.path, step.mode)
      break
    case 'session':
      ws.createSession(step.id, { profile: profileDocument(step.profile ?? {}) })
      break
    case 'close_session':
      await ws.closeSession(step.id)
      break
    case 'set_profile':
      await ws.setSessionProfile(
        step.session ?? ws.defaultSessionId,
        typeof step.profile === 'object' && step.profile !== null
          ? profileDocument(step.profile)
          : step.profile,
      )
      break
    case 'register_cli':
      ws.registerCli(
        step.name,
        new CLI({
          spec: new CommandSpec({ name: step.name }),
          script: new ScriptSource(step.script.source, step.script.language),
          ...(step.runtime !== undefined ? { runtime: step.runtime } : {}),
        }),
        step.config ?? null,
      )
      break
    case 'unregister_cli':
      ws.unregisterCli(step.name)
      break
    case 'clis':
      return [...ws.clis().keys()].sort()
    case 'add_runtime':
      return ws.addRuntime(step.name).name
    case 'remove_runtime':
      await ws.removeRuntime(step.name)
      break
    case 'runtimes':
      return ws.runtimes().map((entry) => entry.name)
    case 'register_policy': {
      if (policies.has(step.id)) throw new Error('policy already registered')
      const policy = new RulePolicy(step)
      ws.policies.add(policy)
      policies.set(step.id, policy)
      break
    }
    case 'unregister_policy': {
      const policy = policies.get(step.id)
      if (policy === undefined) return false
      policies.delete(step.id)
      return ws.policies.remove(policy)
    }
    case 'write':
      await ws.vfs.write(step.path, ENC.encode(step.data))
      break
    case 'read':
      return DEC.decode(await ws.vfs.read(step.path))
    case 'readdir':
      return (await ws.vfs.readdir(step.path)).sort()
    case 'stat': {
      const row = await ws.vfs.stat(step.path)
      return { type: row.type, size: row.size }
    }
    case 'drain_processes':
      await ws.processes.drain()
      break
    case 'spawn': {
      const child = ws.spawn({ argv: step.argv }, step.session)
      child.stdin.close()
      return child.pid
    }
    case 'stream_exec': {
      const session = new Session(ws, step.session ?? null)
      const execution: ShellExecution = await session.shell(step.command, { stream: true })
      let done = false
      const completion = execution.wait().then(
        (result) => {
          done = true
          return { result }
        },
        (error: unknown) => {
          done = true
          return { error }
        },
      )
      const events: { stream: string; data: number[] }[] = []
      let firstBeforeDone = false
      let value: Record<string, unknown>
      try {
        for await (const event of execution.events) {
          if (events.length === 0) firstBeforeDone = !done
          events.push({ stream: event.stream, data: [...event.data] })
          if (step.consume_delay_ms !== undefined) await sleep(step.consume_delay_ms)
          if (step.stop === 'cancel') {
            execution.cancel()
            break
          }
          if (step.stop === 'close') {
            await execution.close()
            break
          }
        }
        const outcome = await completion
        if ('error' in outcome) {
          if (!(outcome.error instanceof Error) || outcome.error.name !== 'AbortError')
            throw outcome.error
          value = { aborted: true }
        } else {
          value = {
            exit_code: outcome.result.exitCode,
            stdout: outcome.result.stdoutText,
            stderr: outcome.result.stderrText,
            refusal: outcome.result.refusal?.reason ?? null,
          }
        }
      } finally {
        await execution.close()
        await completion
      }
      return {
        events,
        bounded: events.every((event) => event.data.length <= 16384),
        stdout_bytes: events.reduce(
          (total, event) => total + (event.stream === 'stdout' ? event.data.length : 0),
          0,
        ),
        stderr_bytes: events.reduce(
          (total, event) => total + (event.stream === 'stderr' ? event.data.length : 0),
          0,
        ),
        first_before_done: firstBeforeDone,
        ...value,
      }
    }
    case 'exec': {
      const abort = new AbortController()
      const timer =
        step.cancel_after_ms === undefined
          ? undefined
          : setTimeout(() => abort.abort(), step.cancel_after_ms)
      const sink = step.sink_delay_ms === undefined ? undefined : new SlowSink(step.sink_delay_ms)
      let result
      try {
        result = await ws.shell(step.command, {
          ...(step.session === undefined ? {} : { sessionId: step.session }),
          ...(step.env === undefined ? {} : { env: step.env }),
          ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
          ...(sink === undefined ? {} : { sink }),
          signal: abort.signal,
        })
      } catch (error) {
        if (abort.signal.aborted && error instanceof Error && error.name === 'AbortError')
          return { aborted: true }
        throw error
      } finally {
        clearTimeout(timer)
      }
      return {
        exit_code: result.exitCode,
        stdout: result.stdoutText,
        stderr: result.stderrText,
        refusal: result.refusal?.reason ?? null,
        ...(sink === undefined
          ? {}
          : { streamed: DEC.decode(await sink.snapshot(Channel.STDOUT)) }),
      }
    }
    case 'concurrent':
      return Promise.all(step.steps.map((sub) => action(host, ws, sub, policies, held)))
    case 'snapshot':
      held.state = await toStateDict(ws)
      break
    case 'checkout': {
      // A checkout onto the running workspace: the restored state wins,
      // and every restored variable clears the session gate first.
      if (held.state === undefined) throw new Error('checkout before snapshot')
      await applyStateDict(ws, held.state)
      break
    }
    case 'mounts':
      return ws
        .mounts()
        .map((m) => m.prefix)
        .sort()
    case 'close':
      await ws.close()
      break
    case 'tools':
      return [...new Session(ws, step.session ?? null).tools.names()]
    case 'tool': {
      const result = await new Session(ws, step.session ?? null).tools.call(
        step.tool,
        step.arguments,
      )
      return { text: result.content[0]?.text ?? '', is_error: result.isError === true }
    }
    case 'asks':
      return ws.decisions
        .pending(step.session ?? '')
        .map((r) => ({ command: r.command, paths: [...r.paths], reason: r.reason }))
    case 'answer':
      for (const record of ws.decisions.pending()) {
        await ws.decisions.answer(
          record.id,
          step.outcome ?? Outcome.ALLOW,
          step.scope ?? Scope.ONCE,
        )
      }
      break
    case 'explain':
      return explained(await new Session(ws, step.session ?? null).explain.shell(step.command))
    case 'vfs': {
      const session = new Session(ws, step.session ?? null)
      const call = VFS_CALL_BY_NAME.get(step.call)
      if (call === undefined) throw new Error(`unknown vfs call: ${step.call}`)
      const args = await checked(call, step.args ?? {})
      if (step.explain === true) {
        return explained((await call.run(session.explain.vfs, args)) as VfsExplanation)
      }
      return answeredCall(session, call, args, false)
    }
    default:
      throw new Error(`unknown lifecycle action: ${String((step as { op: string }).op)}`)
  }
  return null
}

async function run(host: Host, testCase: Case): Promise<number> {
  const mounts: Record<string, BaseVFS> = {}
  for (const [prefix, config] of Object.entries(testCase.settings.mounts)) {
    mounts[prefix] = await host.build(config.vfs, config.config ?? {})
  }
  const profiles = Object.fromEntries(
    Object.entries(testCase.settings.profiles ?? {}).map(([name, profile]) => [
      name,
      parseSessionProfile(profile),
    ]),
  )
  const ws = new host.workspace(mounts, {
    mode: testCase.settings.mode,
    profiles,
    ...(testCase.settings.runtimes !== undefined ? { runtimes: testCase.settings.runtimes } : {}),
  })
  const policies = new Map<string, Policy>()
  const held: Held = {}
  try {
    for (const [index, step] of testCase.steps.entries()) {
      let actual: Record<string, unknown>
      try {
        actual = { value: await action(host, ws, step, policies, held) }
      } catch (err) {
        actual = { error: err instanceof Error ? err.message : String(err) }
        const condition = classify(err)
        if (condition !== null) actual.errno = condition
        if (err instanceof PolicyDenied && err.refusal !== null) actual.reason = err.refusal.reason
      }
      const expected = step.expect ?? { value: null }
      if (!matches(actual, expected)) {
        throw new Error(
          `step ${index + 1} (${step.op}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        )
      }
    }
    return testCase.steps.length
  } finally {
    await ws.close()
  }
}

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((want, at) => matches(actual[at], want))
    )
  }
  if (expected === null || typeof expected !== 'object') {
    return isDeepStrictEqual(actual, expected)
  }
  if (actual === null || typeof actual !== 'object') return false
  const fields = actual as Record<string, unknown>
  return Object.entries(expected).every(([key, want]) => {
    const field = key.replace(/_contains$/, '')
    if (!(field in fields)) return false
    const got = fields[field]
    return key === 'error' || key.endsWith('_contains')
      ? typeof got === 'string' && typeof want === 'string' && got.includes(want)
      : matches(got, want)
  })
}

const corpus = process.argv[2] ?? new URL('./cases.json', import.meta.url)
const suite = JSON.parse(readFileSync(corpus, 'utf8')) as {
  cases: Case[]
}
let passed = 0
let steps = 0
let failures = 0
for (const host of HOSTS) {
  for (const testCase of suite.cases) {
    try {
      steps += await run(host, testCase)
      passed++
      console.log(`ok ${host.name}/${testCase.id}`)
    } catch (err) {
      failures++
      console.error(`FAIL ${host.name}/${testCase.id}: ${String(err)}`)
    }
  }
}
console.log(`${passed} cases / ${steps} steps passed, ${failures} failed`)
process.exitCode = failures > 0 ? 1 : 0
