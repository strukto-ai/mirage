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
  registerVfs as registerNodeVfs,
} from '@struktoai/mirage-node'
import {
  Workspace as BrowserWorkspace,
  buildVfs as buildBrowserVfs,
  registerVfs as registerBrowserVfs,
} from '@struktoai/mirage-browser'
import { Limit, MountMode, type PathSpec } from '@struktoai/mirage-core/types'
import type { Handed } from '@struktoai/mirage-core/vfs/types'
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
  type Action,
  type Ask,
  type CommandContext,
  type CommandExplanation,
  type CommandResultContext,
  type Deny,
  type ExecuteResultContext,
  type VfsContext,
  type VfsResultContext,
  type Route,
  type SessionContext,
  type SessionResultContext,
  type ShellExplanation,
  type ShellNode,
  type VfsExplanation,
} from '@struktoai/mirage-core/policy/types'
import type { RouteContext } from '@struktoai/mirage-core/policy/types'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import { answered as answeredCall, checked } from '@struktoai/mirage-server/io_serde'
import { VFS_CALL_BY_NAME } from '@struktoai/mirage-server/vfs_calls'
import { cliSpecFor } from '@struktoai/mirage-core/commands/cli/specs'
import { CLI, CLIHandler } from '@struktoai/mirage-core/commands/cli/types'
import { command, type Context } from '@struktoai/mirage-core/commands/config'
import { CommandSpec } from '@struktoai/mirage-core/commands/spec/types'
import { chunks } from '@struktoai/mirage-core/io/cooperative'
import { type ByteSource, IOResult, materialize } from '@struktoai/mirage-core/io/types'
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
    clis?: Record<string, { cli: string }>
  }
  steps: Step[]
}

type Step = (
  | ({ op: 'mount'; path: string; mode?: MountMode } & ResourceConfig)
  | { op: 'unmount' | 'read' | 'readdir' | 'cached' | 'stream_stats'; path: string }
  | { op: 'stat'; path: string; fresh?: boolean }
  | { op: 'change'; mount: string; path: string; data?: string }
  | { op: 'write'; path: string; data: string }
  | {
      op: 'exec'
      command: string
      session?: string
      cancel_after_ms?: number
      cancel_on_stall?: string
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
  | { op: 'register_command'; path: string; name: string; write?: boolean; stdout?: string }
  | { op: 'unregister_cli' | 'add_runtime' | 'remove_runtime' | 'stream_cli_stats'; name: string }
  | {
      op: 'register_stream_cli'
      name: string
      exit_code?: number
      stderr?: string
    }
  | ({ op: 'register_policy'; id: string } & RuleHooks)
  | { op: 'tools' | 'asks' }
  | { op: 'tool'; tool: string; arguments: Record<string, unknown> }
  | { op: 'answer'; outcome?: Outcome; scope?: Scope }
  | { op: 'explain'; command: string }
  | { op: 'vfs'; call: string; args?: Record<string, unknown>; explain?: boolean }
  | { op: 'unregister_policy'; id: string }
  | {
      op:
        | 'mounts'
        | 'clis'
        | 'runtimes'
        | 'close'
        | 'snapshot'
        | 'checkout'
        | 'load'
        | 'drain_processes'
    }
  | { op: 'concurrent'; steps: Step[] }
) & { expect?: Record<string, unknown>; session?: string }

type RuleAnswer =
  | { deny: string }
  | { ask: string }
  | { route: string }
  | { limit: { max_bytes?: number; max_lines?: number } }

type RuleHooks = Partial<
  Record<
    | 'pre_execute'
    | 'post_execute'
    | 'pre_command'
    | 'post_command'
    | 'pre_vfs'
    | 'post_vfs'
    | 'pre_session'
    | 'post_session',
    Record<string, RuleAnswer>
  >
>

/**
 * A host policy whose answers are supplied by JSON: per hook, the answer
 * for a word of the line, a command, a path or a variable. Mirrors
 * Python's `RulePolicy`.
 */
class RulePolicy implements Policy {
  constructor(private readonly rule: RuleHooks) {}

  answer(hook: keyof RuleHooks, subject: string, line = false): Action | null {
    for (const [key, answer] of Object.entries(this.rule[hook] ?? {})) {
      if (key !== subject && !(line && subject.includes(key))) continue
      if ('deny' in answer) return { kind: 'deny', reason: answer.deny }
      if ('ask' in answer) return { kind: 'ask', reason: answer.ask }
      if ('route' in answer) return { kind: 'route', runtime: answer.route }
      return new Limit({
        maxBytes: answer.limit.max_bytes ?? null,
        maxLines: answer.limit.max_lines ?? null,
      })
    }
    return null
  }

  preExecute(ctx: RouteContext): Action | null {
    return this.answer('pre_execute', ctx.line, true)
  }

  postExecute(ctx: ExecuteResultContext): Action | null {
    return this.answer('post_execute', ctx.line, true)
  }

  preCommand(ctx: CommandContext): Action | null {
    return this.answer('pre_command', ctx.command)
  }

  postCommand(ctx: CommandResultContext): Action | null {
    return this.answer('post_command', ctx.command)
  }

  preVfs(ctx: VfsContext): Action | null {
    return this.answer('pre_vfs', ctx.path.virtual)
  }

  postVfs(ctx: VfsResultContext): Action | null {
    return this.answer('post_vfs', ctx.path.virtual)
  }

  preSession(ctx: SessionContext): Action | null {
    return this.answer('pre_session', ctx.key)
  }

  postSession(ctx: SessionResultContext): Action | null {
    return this.answer('post_session', ctx.key)
  }
}

interface ScriptDocument {
  source: string
  language: 'python' | 'js'
}

function profileDocument(raw: Record<string, unknown>) {
  const doc = { ...raw }
  if (doc.policy != null) {
    const policy = doc.policy as Record<string, { script: ScriptDocument; runtime: unknown }[]>
    doc.policy = Object.fromEntries(
      Object.entries(policy).map(([method, programs]) => [
        method,
        programs.map((program) => ({
          ...program,
          script: new ScriptSource(program.script.source, program.script.language),
        })),
      ]),
    )
  }
  return parseSessionProfile(doc)
}

interface Host {
  name: string
  workspace: new (mounts: Record<string, BaseVFS>, options: WorkspaceOptions) => Workspace
  build: (name: string, config: Record<string, unknown>) => Promise<BaseVFS>
  load: (tar: Uint8Array) => Promise<Workspace>
}

const HOSTS: Host[] = [
  {
    name: 'node',
    workspace: NodeWorkspace,
    build: buildNodeVfs,
    load: (tar) => NodeWorkspace.load(tar),
  },
  {
    name: 'browser',
    workspace: BrowserWorkspace,
    build: buildBrowserVfs,
    load: (tar) => BrowserWorkspace.load(tar),
  },
]
const ENC = new TextEncoder()
const DEC = new TextDecoder()
const STALL_DEADLINE_MS = 10_000

class CachedRAMVFS extends RAMVFS {
  override readonly cachesReads = true
}

/** A local fixture keeping listings, changed behind them like a shared backend. */
class ListedRAMVFS extends RAMVFS {
  override readonly indexTtl: number = 600

  /** Replace or remove a file without telling any workspace; no data removes it. */
  change(key: string, data: string | undefined): void {
    if (data === undefined) this.store.files.delete(key)
    else this.store.files.set(key, ENC.encode(data))
  }
}

/** A local fixture holding a full scan to `fullScanLimit` files. */
class LimitedRAMVFS extends RAMVFS {
  constructor(files: Record<string, string>, fullScanLimit: number) {
    super({ fullScanLimit })
    const dirs = new Set(['/'])
    for (const path of Object.keys(files)) {
      const parts = path.split('/')
      for (let depth = 2; depth < parts.length; depth++) dirs.add(parts.slice(0, depth).join('/'))
    }
    this.loadState({
      type: 'ram',
      files: Object.fromEntries(
        Object.entries(files).map(([path, data]) => [path, ENC.encode(data)]),
      ),
      dirs: [...dirs].sort(),
    })
  }
}

/** A chunked source whose pull and close counts are shared corpus assertions. */
class TrackedStreamVFS extends CachedRAMVFS {
  pulls = 0
  closed = 0
  onStall: (() => void) | undefined

  constructor(
    private readonly chunkSize: number,
    private readonly failAfter?: number,
    private readonly stallAfter?: number,
    private readonly failErrno?: string,
  ) {
    super()
  }

  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
    signal?: AbortSignal,
  ): Promise<ByteSource> {
    if (offset !== 0 || size !== null) return super.read(path, handed, offset, size, signal)
    return this.tracked(await materialize(await super.read(path, handed)), signal)
  }

  private async *tracked(
    data: Uint8Array,
    signal?: AbortSignal,
  ): AsyncIterableIterator<Uint8Array> {
    try {
      for (let offset = 0; offset < data.byteLength; offset += this.chunkSize) {
        this.pulls++
        if (this.stallAfter !== undefined && offset / this.chunkSize >= this.stallAfter) {
          if (this.onStall !== undefined) queueMicrotask(this.onStall)
          await sleep(Infinity, signal)
        }
        if (this.failAfter !== undefined && offset / this.chunkSize >= this.failAfter) {
          throw Object.assign(new Error('stream tail fetched'), { code: this.failErrno })
        }
        yield data.subarray(offset, offset + this.chunkSize)
      }
    } finally {
      this.closed++
    }
  }
}

/**
 * A store whose uploads fail with its own error, no fs code, as a Drive 503
 * or an S3 client's error on commit does.
 */
class RejectedUploadVFS extends RAMVFS {
  constructor(private readonly message: string) {
    super()
  }

  override write(): Promise<void> {
    return Promise.reject(new Error(this.message))
  }

  override append(): Promise<void> {
    return Promise.reject(new Error(this.message))
  }

  override pwrite(): Promise<void> {
    return Promise.reject(new Error(this.message))
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

  invoke(_config: unknown, _paths: unknown, _texts: unknown, ctx: Context): CommandFnResult {
    const result = new IOResult({ stderr: ENC.encode(this.stderr) })
    return [this.output(ctx, result), result]
  }

  async *output(ctx: Context, result: IOResult): AsyncIterableIterator<Uint8Array> {
    try {
      for await (const chunk of chunks(ctx.stdin ?? new Uint8Array())) {
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
      config.fail_errno as string | undefined,
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
  register('listed-ram', () => Promise.resolve(new ListedRAMVFS()))
  register('rejected-upload', (config) =>
    Promise.resolve(
      new RejectedUploadVFS((config.message as string | undefined) ?? 'upload refused'),
    ),
  )
  register('limited-ram', (config) =>
    Promise.resolve(
      new LimitedRAMVFS(
        (config.files ?? {}) as Record<string, string>,
        (config.full_scan_limit as number | undefined) ?? -1,
      ),
    ),
  )
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
          handlers: {
            '': new CLIHandler({
              fn: (config, paths, texts, ctx) => cli.invoke(config, paths, texts, ctx),
            }),
          },
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
    case 'change': {
      const vfs = ws.mount(step.mount).vfs
      if (!(vfs instanceof ListedRAMVFS)) throw new Error('change requires a listed-ram mount')
      vfs.change(step.path, step.data)
      return null
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
    case 'register_command': {
      const out = new TextEncoder().encode(step.stdout ?? '')
      ws.mount(step.path).registerCommands(
        command({
          name: step.name,
          vfs: null,
          spec: new CommandSpec(),
          write: step.write ?? false,
          fn: () => [out, new IOResult()],
        }),
      )
      break
    }
    case 'unregister_cli':
      await ws.unregisterCli(step.name)
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
      const row = await ws.vfs.stat(step.path, undefined, { fresh: step.fresh === true })
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
      const stalled =
        step.cancel_on_stall === undefined ? undefined : ws.mount(step.cancel_on_stall).vfs
      if (stalled !== undefined && !(stalled instanceof TrackedStreamVFS)) {
        throw new Error('cancel_on_stall requires a tracked-stream mount')
      }
      if (stalled !== undefined) stalled.onStall = () => abort.abort()
      let gaveUp = false
      const timer =
        step.cancel_after_ms !== undefined
          ? setTimeout(() => abort.abort(), step.cancel_after_ms)
          : stalled !== undefined
            ? setTimeout(() => {
                gaveUp = true
                abort.abort()
              }, STALL_DEADLINE_MS)
            : undefined
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
        if (abort.signal.aborted && error instanceof Error && error.name === 'AbortError') {
          if (gaveUp) {
            throw new Error(
              `${String(step.cancel_on_stall)} did not stall within ${String(STALL_DEADLINE_MS / 1000)}s`,
            )
          }
          return { aborted: true }
        }
        throw error
      } finally {
        if (stalled !== undefined) stalled.onStall = undefined
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

/** Save `ws` to a tar and load it as a new workspace, closing `ws`. */
async function reload(host: Host, ws: Workspace): Promise<Workspace> {
  const loaded = await host.load(await ws.snapshot())
  await ws.close()
  return loaded
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
  let ws = new host.workspace(mounts, {
    mode: testCase.settings.mode,
    profiles,
    ...(testCase.settings.runtimes !== undefined ? { runtimes: testCase.settings.runtimes } : {}),
  })
  for (const [name, block] of Object.entries(testCase.settings.clis ?? {})) {
    ws.registerCli(name, cliSpecFor(block.cli))
  }
  const policies = new Map<string, Policy>()
  const held: Held = {}
  try {
    for (const [index, step] of testCase.steps.entries()) {
      let actual: Record<string, unknown>
      try {
        if (step.op === 'load') {
          ws = await reload(host, ws)
          actual = { value: null }
        } else {
          actual = { value: await action(host, ws, step, policies, held) }
        }
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
