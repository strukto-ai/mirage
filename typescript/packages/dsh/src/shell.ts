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

import type { Context } from '@deepseek-ai/cordis'
import { DSH_ENV_PREFIX, ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell'
import type { SubprocessOutputRead } from '@deepseek-ai/dsh-subprocess'
import {
  Channel,
  JobConsole,
  KILLED_OUTCOME,
  exitOutcome,
} from '@struktoai/mirage-core/shell/console/index'
import type {
  ConsoleChunk,
  ConsoleStore,
  ReadResult,
} from '@struktoai/mirage-core/shell/console/index'
import { setCwd } from '@struktoai/mirage-core/workspace/session/shell_dirs'
import { sessionView } from '@struktoai/mirage-core/workspace/session/state'
import type {
  ExecuteOptions,
  ExecuteResult,
} from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { Workspace } from '@struktoai/mirage-node'
import { StreamTail, TailBuffer } from './text.ts'
import { SpillSink, ensureDirPath, type SpillTarget } from './spill.ts'
import type {} from './service.ts'
import type { Refusal } from '@struktoai/mirage-core/types'
import { refusalLine } from '@struktoai/mirage-core/workspace/tools/io_text'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_STDOUT_MAX_BYTES = 200_000
const DEFAULT_STDERR_MAX_BYTES = 64_000
const STDERR_MARKER = new TextEncoder().encode('\n--- stderr ---\n')
// Monotonic within the process, so concurrent background commands never
// collide on a spill filename. Not reset, so it needs no time or randomness.
let spillCounter = 0

// The mount whose writability a `read-only` policy keeps, because dsh's
// own definition of that mode keeps it: "permits only required sinks such
// as /dev/null". Narrowing it too would make `cmd > /dev/null` fail, which
// no read-only sandbox anywhere does.
const SINK_PREFIX = '/dev'

// How mirage refuses a write the session's mount grants do not allow: the
// write itself is refused, in the read-only voice, whether a command or a
// redirection made it. Hide refusals keep `Permission denied`. Only
// consulted for a call that ran under `read-only`, so the only permission
// error these can catch is the one this executor just imposed.
const DENIAL_SIGNATURES = ['read-only mount at ', ': Permission denied', ': Read-only file system']

/** Configuration for the mirage shell executor. */
export interface MirageShellConfig {
  /**
   * Default working directory for commands. Defaults to `/`. With
   * `sessionId` it instead seeds the bound session's initial cwd, and the
   * session's own cwd is the default from then on.
   */
  workdir?: string
  /** Default foreground timeout in milliseconds. Defaults to 120000. */
  defaultTimeoutMs?: number
  /** Upper cap on any requested timeout. Defaults to 600000. */
  maxTimeoutMs?: number
  /** Default stdout capture budget in bytes. Defaults to 200000. */
  stdoutMaxBytes?: number
  /** stderr capture budget in bytes. Defaults to 64000. */
  stderrMaxBytes?: number
  /**
   * Bind every command to this named workspace session. By default each
   * command runs in an ephemeral fork of the workspace's default session,
   * so nothing persists between calls, which is the one-shot contract of
   * dsh's bash tool. With a session bound, `cd`, `export`, and function
   * definitions persist across calls, the persistent-shell contract. The
   * session is created on first use if the workspace does not have it; an
   * existing session is adopted as is.
   *
   * A spec carrying an explicit `env`, or a `workdir` that names a real
   * directory in this world, still runs as a one-call subshell of the
   * bound session, per mirage's `ExecuteOptions` semantics: both say
   * "just for this command". The two things dsh injects on every call
   * are deliberately not read that way, since neither carries that
   * intent and either would fork every command and leave the binding
   * with nothing to persist. A workdir resolved on the harness's own
   * machine names nothing here and is dropped; the managed `DSH_*`
   * snapshot is seeded into the session instead.
   */
  sessionId?: string
  /**
   * When set, a background command whose streamed output overruns its
   * delta budget spills its full stdout and stderr to files under this
   * workspace directory, and `readOutput()` points at them so a reader
   * can recover what the delta dropped. The directory is a workspace
   * path (e.g. `/tmp` on a ram mount), so the agent reads the spill
   * through the same VFS as everything else; the writes go through the
   * workspace, so they appear in history like any other write. Unset
   * (the default) means no spill: output that overruns is simply
   * flagged `lossy`, the honest "no safe path available" answer.
   */
  spillDir?: string
}

function executeOptions(
  spec: ShellExecSpec,
  workdir: string,
  signal: AbortSignal,
  sessionId: string | undefined,
  bound: boolean,
  fallbackWorkdir: string,
  sink?: JobConsole,
): ExecuteOptions {
  // A per-call `env` makes mirage fork a subshell, exactly as `cwd` does,
  // so what goes in it decides whether anything can persist. Bound to a
  // session, only a genuine per-call override belongs here: dsh sends a
  // non-empty managed `DSH_*` snapshot on every single call, and carrying
  // that per call would fork every command and quietly undo the binding.
  // Those facts are seeded into the session instead, by `applyManagedEnv`.
  const managed = (spec.dshEnv as Record<string, string> | undefined) ?? {}
  const env = bound ? { ...(spec.env ?? {}) } : { ...(spec.env ?? {}), ...managed }
  // Unbound, `cwd` is always present so every command runs in an ephemeral
  // fork: isolation must not hinge on a spec happening to carry a workdir,
  // and a read-only call runs in a *named* twin session, so without a cwd
  // its `cd` and exports would persist into the next nominally one-shot
  // call. Bound, an absent workdir runs in the session itself, which is
  // what lets its state persist. Either way the decision is the binding's,
  // never the session this particular call happens to land in.
  const cwd = workdir !== '' ? workdir : bound ? undefined : fallbackWorkdir
  return {
    signal,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(spec.stdin !== undefined ? { stdin: new TextEncoder().encode(spec.stdin) } : {}),
    ...(sink !== undefined ? { sink } : {}),
  }
}

/** Where and as whom one command runs, settled before it starts. */
interface Prepared {
  ws: Workspace
  sessionId: string | undefined
  bound: boolean
  workdir: string
}

/**
 * Wait for `work` until `signal` fires; the reason the signal carries is
 * then the rejection, and the work runs on unwatched.
 *
 * @param work the step being waited for.
 * @param signal the signal that ends the wait.
 * @returns what the step resolved with.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason as Error)
    }
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

/** How a settled execution ended, read once it has: the first cause wins. */
interface Classification {
  timedOut: boolean
  aborted: boolean
}

/** What an execution needs from its executor, beyond the run itself. */
interface ExecutionParts {
  controller: AbortController
  /** Budget of the consuming `readOutput` backlog. */
  budget: number
  stdoutMaxBytes: number
  stderrMaxBytes: number
  timeoutMs: number
  spill: SpillSink | null
  classify: () => Classification
  /** The sandbox facts once the run settled, its denial read off them. */
  verdict: (result: ExecuteResult | null, stderr: string) => ShellSandboxInfo | undefined
  disarm: () => void
}

/**
 * The console store one execution streams through: each chunk goes to the
 * execution as the command emits it, and none is retained. The command
 * awaits every emit, so a spill write holds it back rather than piling up
 * behind it, and no retention budget can drop a chunk before it was read:
 * memory holds only what the execution's bounded tails and backlog keep.
 */
class ExecutionStore implements ConsoleStore {
  private nextSeq = 0
  private isClosed = false
  private waiters: (() => void)[] = []

  constructor(private readonly deliver: (chunk: ConsoleChunk) => Promise<void>) {}

  get closed(): boolean {
    return this.isClosed
  }

  async append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
    const chunk: ConsoleChunk = { seq: this.nextSeq, ts: Date.now() / 1000, channel, data }
    this.nextSeq += 1
    await this.deliver(chunk)
    return chunk
  }

  readFrom(): Promise<ReadResult> {
    return Promise.resolve([[], this.nextSeq, false])
  }

  wait(): Promise<void> {
    if (this.isClosed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  close(): Promise<void> {
    this.isClosed = true
    for (const resolve of this.waiters.splice(0)) resolve()
    return Promise.resolve()
  }
}

/**
 * One command over the workspace executor, streamed through a `JobConsole`:
 * the handle `execute` returns, whether the caller awaits `result()` (a
 * foreground run) or keeps the handle (a background one).
 *
 * The command runs with the console as its `sink`, so each statement of a
 * compound line lands as it finishes rather than the whole line arriving at
 * the end (a single command still shows up in one chunk, having nothing to
 * emit before it completes). Each chunk goes to three places: the consuming
 * `readOutput` backlog, which hands back and clears, so consecutive reads
 * never re-deliver; and one bounded tail per stream, which `observed` reads
 * at a caller's own offsets and `result()` projects once the command is
 * over. Unread output is bounded on every path: a tail or the backlog that
 * overruns its budget drops its head, keeping the tail, and the full stream
 * moves to spill files. `kill()` aborts cooperatively (the executor observes
 * the signal between pipeline stages and inside sleep).
 */
class MirageShellExecution implements ShellExecution {
  status: ShellProcessStatus = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  sandbox?: ShellSandboxInfo
  readonly done: Promise<void>
  readonly observed: ShellExecution['observed']

  private readonly parts: ExecutionParts
  private readonly console: JobConsole
  private readonly pending: TailBuffer
  private readonly stdoutTail: StreamTail
  private readonly stderrTail: StreamTail
  private failure: { error: unknown } | null = null
  private settledResult: Promise<ShellRunResult> | null = null
  private lossy = false
  private inStderr = false
  private settled = false

  /**
   * @param launch starts the command streaming into the console it is
   *   handed; null when the deadline expired while it was being prepared.
   * @param parts what the execution needs from its executor.
   */
  constructor(
    launch: ((sink: JobConsole) => Promise<ExecuteResult>) | null,
    parts: ExecutionParts,
  ) {
    this.parts = parts
    this.console = new JobConsole(
      new ExecutionStore((chunk) =>
        chunk.channel === Channel.CONTROL ? Promise.resolve() : this.appendChunk(chunk),
      ),
    )
    this.pending = new TailBuffer(parts.budget)
    this.stdoutTail = new StreamTail(parts.stdoutMaxBytes)
    this.stderrTail = new StreamTail(parts.stderrMaxBytes)
    this.observed = {
      stdout: { readFrom: (from) => this.readStream(this.stdoutTail, from, 'stdout') },
      stderr: { readFrom: (from) => this.readStream(this.stderrTail, from, 'stderr') },
    }
    // A null launch is a deadline that expired while the command was still
    // being prepared: it settles at once, timed out, with no output.
    this.done =
      launch === null
        ? this.settleExpired()
        : launch(this.console).then(
            (result) => this.settle(result, null),
            (err: unknown) => this.settle(null, err),
          )
  }

  private readStream(
    tail: StreamTail,
    fromByte: number,
    channel: 'stdout' | 'stderr',
  ): SubprocessOutputRead {
    const read = tail.readFrom(fromByte)
    const spillPath =
      channel === 'stdout' ? this.parts.spill?.stdoutPath : this.parts.spill?.stderrPath
    return { ...read, ...(spillPath !== undefined ? { spillPath } : {}) }
  }

  private async appendChunk(chunk: ConsoleChunk): Promise<void> {
    const spill = this.parts.spill
    // The full, uncapped stream goes to the spill sink (if enabled)
    // before anything is capped, so nothing a tail or the backlog drops
    // is lost to a reader that follows the spill path.
    if (spill !== null) await spill.ingest(chunk.channel, chunk.data)
    const tail = chunk.channel === Channel.STDERR ? this.stderrTail : this.stdoutTail
    tail.append(chunk.data)
    // stderr rides the same backlog as stdout, opened by a marker so the
    // reader can tell the two apart; a run of stderr chunks marks once.
    let dropped = false
    if (chunk.channel === Channel.STDERR) {
      if (!this.inStderr) {
        dropped = this.pending.append(STDERR_MARKER)
        this.inStderr = true
      }
    } else {
      this.inStderr = false
    }
    // The backlog bounds itself as it grows, so a reader that never
    // drains cannot grow it without limit and an append costs the chunk
    // rather than everything buffered before it. The tail is kept (the
    // freshest output).
    dropped = this.pending.append(chunk.data) || dropped
    if (dropped) this.lossy = true
    // Something just dropped bytes; move the full stream to files so a
    // reader can still recover them from the spill path.
    if ((dropped || tail.truncated) && spill !== null) await spill.begin()
  }

  private async settle(result: ExecuteResult | null, err: unknown): Promise<void> {
    this.settled = true
    let outcome: string
    if (result !== null) {
      this.status = 'completed'
      this.exitCode = result.exitCode
      outcome = exitOutcome(result.exitCode)
    } else {
      this.status = 'killed'
      this.signal = 'SIGTERM'
      outcome = KILLED_OUTCOME
      // Mirage answers an abort by throwing, so only a throw no abort
      // explains is an infrastructure failure: `result()` rejects with it,
      // and the read path carries it on stderr for a background reader.
      if (!this.parts.controller.signal.aborted) {
        this.failure = { error: err }
        const message = err instanceof Error ? err.message : String(err)
        await this.console.emit(Channel.STDERR, new TextEncoder().encode(message))
      }
    }
    // A refusal's reason is one more stderr line, after what the shell
    // printed in bash's own words.
    if (result !== null) {
      const before = this.stderrTail.readFrom(0).text
      const line = refusalLine(before, result.refusal)
      if (line !== '') {
        const lead = before === '' || before.endsWith('\n') ? '' : '\n'
        await this.console.emit(Channel.STDERR, new TextEncoder().encode(lead + line))
      }
    }
    // Every emit was awaited as it was made, so everything the command
    // printed has landed by now and a read after `done` is whole.
    await this.console.finish(outcome)
    this.stdoutTail.end()
    this.stderrTail.end()
    const stderr = this.stderrTail.readFrom(0).text
    const sandbox = this.parts.verdict(result, stderr)
    if (sandbox !== undefined) this.sandbox = sandbox
    this.parts.disarm()
  }

  private async settleExpired(): Promise<void> {
    this.settled = true
    this.status = 'killed'
    await this.console.finish(KILLED_OUTCOME)
    const sandbox = this.parts.verdict(null, '')
    if (sandbox !== undefined) this.sandbox = sandbox
    this.parts.disarm()
  }

  readOutput(): ShellProcessRead {
    const delta = this.pending.take()
    const lossy = this.lossy
    this.lossy = false
    const spill = this.parts.spill
    return {
      delta,
      lossy,
      ...(spill?.stdoutPath !== undefined ? { stdoutSpillPath: spill.stdoutPath } : {}),
      ...(spill?.stderrPath !== undefined ? { stderrSpillPath: spill.stderrPath } : {}),
    }
  }

  kill(): boolean {
    if (this.settled) return false
    this.parts.controller.abort()
    return true
  }

  result(): Promise<ShellRunResult> {
    this.settledResult ??= this.done.then(() => {
      if (this.failure !== null) throw this.failure.error
      return {
        exitCode: this.exitCode,
        signal: this.signal,
        ...this.parts.classify(),
        timeoutMs: this.parts.timeoutMs,
        stdout: this.collected(this.stdoutTail, 'stdout'),
        stderr: this.collected(this.stderrTail, 'stderr'),
        ...(this.sandbox !== undefined ? { sandbox: this.sandbox } : {}),
      }
    })
    return this.settledResult
  }

  private collected(tail: StreamTail, channel: 'stdout' | 'stderr'): CollectedOutput {
    const read = this.readStream(tail, 0, channel)
    return {
      text: read.text,
      truncated: read.lossy,
      ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
    }
  }
}

/**
 * Mirage-backed implementation of `ctx.shell`: `run` executes the command
 * line with mirage's own shell (coreutils-faithful commands, installed
 * CLIs, the policy layer) against the shared `ctx.mirage` workspace, so a
 * path from `ctx.fs` means the same file here. There is no OS process
 * behind a command: `signal` in results is a compatibility value for kills,
 * and abort/timeout act cooperatively at the executor's own boundaries.
 *
 * Every command runs in an ephemeral fork of the workspace's default
 * session, so no shell state survives from one call to the next, matching
 * the one-shot contract of dsh's bash tool. Configuring a `sessionId`
 * binds all commands to one named session instead, whose cwd, exports,
 * and functions persist across calls.
 */
export class MirageShellExecutor extends ShellExecutor {
  static readonly inject = ['mirage']

  private readonly workdir: string
  private readonly defaultTimeoutMs: number
  private readonly maxTimeoutMs: number
  private readonly stdoutMaxBytes: number
  private readonly stderrMaxBytes: number
  private readonly sessionId: string | undefined
  private readonly spillDir: string | undefined
  private sessionReady: Promise<void> | null = null
  private readOnlyReady: Promise<string> | null = null
  private readonly seeding = new Map<string, Promise<unknown>>()
  private issued = 0
  private readonly seeded = new Map<string, number>()

  constructor(ctx: Context, config: MirageShellConfig = {}) {
    super(ctx)
    this.workdir = config.workdir ?? '/'
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTimeoutMs = config.maxTimeoutMs ?? MAX_TIMEOUT_MS
    this.stdoutMaxBytes = config.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES
    this.stderrMaxBytes = config.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES
    this.sessionId = config.sessionId
    this.spillDir = config.spillDir
  }

  // The workspace may still be building (declarative mounts resolve
  // asynchronously), so every execution awaits the service's `ready`.
  private workspace(): Promise<Workspace> {
    return this.ctx.mirage.ready
  }

  /**
   * The directory this command actually runs in.
   *
   * dsh fills an unspecified workdir from the calling session's cwd (by
   * way of the sandbox policy's workspace root), and that is a directory
   * on the harness's own machine, which names nothing here. Running
   * there leaves `pwd` reporting a path the agent cannot reach and every
   * relative path failing, and, because a per-call cwd forks a subshell,
   * it also defeats a bound session on every call. So a workdir that is
   * not a directory in this world is treated as unset: the configured
   * default when unbound, the session's own cwd when bound.
   *
   * @param spec the resolved spec whose workdir is being placed.
   * @returns the workdir to execute under, `''` meaning the session's own.
   */
  private async worldWorkdir(spec: ShellExecSpec): Promise<string> {
    if (spec.workdir === '') return ''
    const ws = await this.workspace()
    if (await ws.vfs.isDir(spec.workdir)) return spec.workdir
    return this.sessionId === undefined ? this.workdir : ''
  }

  // A spill sink for one background command, or null when no spill
  // directory is configured. The target reaches the live workspace so
  // the full stream lands on a mount the agent can read back.
  private newSpill(): SpillSink | null {
    const dir = this.spillDir
    if (dir === undefined) return null
    const target: SpillTarget = {
      ensureDir: async (d) => {
        const ws = await this.workspace()
        await ensureDirPath({ exists: (p) => ws.vfs.exists(p), mkdir: (p) => ws.vfs.mkdir(p) }, d)
      },
      write: async (p, bytes) => {
        const ws = await this.workspace()
        await ws.vfs.write(p, bytes)
      },
      append: async (p, bytes) => {
        const ws = await this.workspace()
        await ws.vfs.append(p, bytes)
      },
    }
    spillCounter += 1
    const log = this.ctx.logger('mirage-dsh')
    return new SpillSink(target, dir, `mirage-shell-${spillCounter.toString()}`, (err: unknown) => {
      log.debug('spill to %s failed, output will not be recoverable: %o', dir, err)
    })
  }

  /**
   * With every runtime in the world reaching only the vfs
   * (`ctx.mirage.vfsOnly`), the workspace dispatch is the single gate
   * for anything a command can do, so this executor behaves like a
   * workspace-write sandbox: reads and writes land only where mounts
   * (and their modes) allow. Declaring it lets sandbox-aware plugins
   * (dsh's permission presets) compose over this executor. A world
   * holding a runtime with entry points around the gate (the host `local`
   * python, a remote sandbox) voids that claim, so this answers
   * undefined then (the base contract's "does not sandbox") and those
   * plugins refuse to compose instead of trusting a lie.
   */
  override get sandboxMode(): ShellExecutor['sandboxMode'] {
    return this.ctx.mirage.vfsOnly ? 'workspace-write' : undefined
  }

  /**
   * The mode this one call runs under: the policy the caller resolved
   * for it, or this executor's own default when the call carried none.
   * Undefined keeps the "no claim" answer for a world some runtime can
   * act outside of, where no mode would be true.
   *
   * @param spec the resolved spec whose policy is being read.
   * @returns the effective mode, or undefined when nothing is claimed.
   */
  private modeFor(spec: ShellExecSpec): ShellExecutor['sandboxMode'] {
    const declared = this.sandboxMode
    if (declared === undefined) return undefined
    return spec.sandboxPolicy?.mode ?? declared
  }

  /**
   * The session this call runs in: the read-only twin when the policy
   * confines it to reads, else this executor's own binding.
   *
   * `workspace-write` and `danger-full-access` both run in the ordinary
   * session, because the mounts and their modes already are the
   * workspace boundary and mirage has nothing wider to grant.
   *
   * @param spec the resolved spec whose policy selects the session.
   * @returns the session id to execute under, or undefined for the default.
   */
  private async sessionFor(spec: ShellExecSpec): Promise<string | undefined> {
    if (this.modeFor(spec) !== 'read-only') return this.sessionId
    return this.readOnlySession()
  }

  /**
   * The sandbox facts to stamp on this run's result and process handle,
   * or undefined when the world is not fully workspace-bound (no claim).
   *
   * `enforcement` is 'full': when every runtime reaches only the vfs, the
   * workspace gate cannot be bypassed, so unlike an OS sandbox on an older
   * kernel there is no promised effect it fails to govern. `runnerFailed`
   * is false because the workspace executor is the runner and a failure to
   * run surfaces as a rejected/aborted execution, not a runner that never
   * started.
   *
   * @param spec the resolved spec this run was built from.
   * @param denied whether the run was refused a write by the narrowing.
   * @returns the facts to stamp, or undefined when nothing is claimed.
   */
  private sandboxInfo(spec: ShellExecSpec, denied = false): ShellSandboxInfo | undefined {
    const mode = this.modeFor(spec)
    if (mode === undefined) return undefined
    return { mode, denied, enforcement: 'full', runnerFailed: false }
  }

  /**
   * Whether this run was refused, by the session's permission document
   * or by the read-only narrowing.
   *
   * The document's refusals ride the result itself: a `Deny`, an
   * unanswered ask and a policy that raised all leave `refusal` on the
   * `ExecuteResult`, whatever the line did with its streams (`2>&1`, a
   * trailing command that owns the status). That record is read for
   * every call, because a role's `commands.deny` and `commands.ask`
   * rules bind under `workspace-write` and `danger-full-access` alike:
   * a mode says what the mounts allow, and says nothing about whether a
   * rule forbids the line. The narrowing has no record, since it is
   * EROFS/EACCES from the mounts, so its signatures are still read off
   * stderr, and only for a call that ran read-only, where this executor
   * is what imposed it.
   *
   * @param spec the resolved spec this run was built from.
   * @param result what the workspace answered.
   * @param stderr the run's captured standard error.
   * @returns true when something refused the run.
   */
  private wasDenied(
    spec: ShellExecSpec,
    result: { readonly refusal: Refusal | null },
    stderr: string,
  ): boolean {
    if (result.refusal !== null) return true
    if (this.modeFor(spec) !== 'read-only') return false
    return DENIAL_SIGNATURES.some((signature) => stderr.includes(signature))
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    // Bound to a session, an unspecified workdir stays empty so the
    // session's own cwd governs; filling the default here would turn
    // every call into a subshell and nothing would ever persist.
    const workdir = request.workdir ?? (this.sessionId === undefined ? this.workdir : '')
    return {
      command: request.command,
      workdir,
      timeoutMs: Math.min(request.timeoutMs ?? this.defaultTimeoutMs, this.maxTimeoutMs),
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? this.stdoutMaxBytes,
      signal: request.signal,
      stdin: request.stdin,
      env: request.env,
      dshEnv: request.dshEnv,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  private ensureSession(): Promise<void> {
    if (this.sessionId === undefined) return Promise.resolve()
    this.sessionReady ??= this.provisionSession(this.sessionId).catch((err: unknown) => {
      this.sessionReady = null
      throw err
    })
    return this.sessionReady
  }

  /**
   * Seed this call's managed `DSH_*` snapshot into the bound session.
   *
   * These are harness facts about the session (its home, its id), not
   * overrides for one command, and on a bound session they have to live
   * in the session: handed over as a per-call `env` they would fork a
   * subshell on every call, since dsh never sends an empty snapshot.
   *
   * The snapshot replaces rather than merges, per the seam's own rule
   * that a fact absent from the current snapshot must not inherit a
   * stale value from an earlier one. Only the managed namespace is
   * touched, so a variable the agent exported itself is left alone.
   *
   * @param ws the live workspace holding the session.
   * @param sessionId the session this call runs in.
   * @param managed the call's managed snapshot.
   */
  private async applyManagedEnv(
    ws: Workspace,
    sessionId: string,
    managed: Record<string, string>,
  ): Promise<void> {
    const session = ws.getSession(sessionId)
    const view = sessionView(session)
    for (const key of Object.keys(session.env)) {
      if (key.startsWith(DSH_ENV_PREFIX) && !(key in managed)) await view.unset(key)
    }
    for (const [key, value] of Object.entries(managed)) await view.set(key, value)
  }

  private readOnlySession(): Promise<string> {
    this.readOnlyReady ??= this.provisionReadOnly().catch((err: unknown) => {
      this.readOnlyReady = null
      throw err
    })
    return this.readOnlyReady
  }

  /**
   * Create (once) the session a read-only call runs in: a twin of the
   * session this executor would otherwise use, with every grant it holds
   * narrowed to `read`, so mirage's own dispatch is what refuses the
   * write rather than a second permission layer bolted on here.
   *
   * The twin narrows, never widens, and that takes every part of the
   * source's view, which is what `narrow` in core stamps: modes, hidden
   * paths, hidden variables, command rules. Its modes cover every mount
   * at `read` (the one exception is the null sink, per
   * {@link SINK_PREFIX}), which is at least as narrow as whatever the
   * source held, since `read` is the weakest mode there is; naming a
   * mount only narrows it, so a prefix the map omits would keep its own
   * mode rather than disappear. The other three are copied from the
   * source session rather than recompiled, because the profile it was
   * created under is not something a session records.
   *
   * Leaving any of them behind widens. Hides are the obvious one: a
   * binding confined to `/allowed` would read `/secret` in read-only
   * mode although the same command is refused outside it. Command rules
   * are the one modes cannot stand in for, because a mode bounds a
   * mount and an account CLI reaches a service: a profile that denies
   * `slack message send` or `git push` still denies it here, where
   * every mount being `read` says nothing at all about it.
   *
   * The policy's `workspaceRoot` is deliberately not consulted anywhere:
   * it is a directory on the harness's machine, so containment against
   * it says nothing about this world. The mounts are the boundary.
   *
   * @returns the id of the read-only session.
   */
  private async provisionReadOnly(): Promise<string> {
    const ws = await this.workspace()
    const sessionId = `${this.sessionId ?? 'mirage-dsh'}::read-only`
    await ws.ensureSessionsLoaded()
    if (ws.listSessions().some((s) => s.sessionId === sessionId)) return sessionId
    const source = ws.getSession(this.sessionId ?? ws.defaultSessionId)
    const grants: Record<string, string> = {}
    for (const entry of ws.mounts()) {
      grants[entry.prefix] = rstripSlash(entry.prefix) === SINK_PREFIX ? 'exec' : 'read'
    }
    const hidden = source.visibility.paths
    const hide = [...(hidden?.paths ?? []), ...(hidden?.patterns ?? [])]
    const twin = ws.createSession(sessionId, {
      mounts: grants,
      ...(hide.length > 0 ? { permissions: { paths: { hide } } } : {}),
    })
    twin.commands = source.commands
    twin.visibility = {
      ...twin.visibility,
      vars: source.visibility.vars,
      commands: source.visibility.commands,
    }
    setCwd(twin, this.workdir)
    return sessionId
  }

  private async provisionSession(sessionId: string): Promise<void> {
    const ws = await this.workspace()
    await ws.ensureSessionsLoaded()
    if (ws.listSessions().some((s) => s.sessionId === sessionId)) return
    setCwd(ws.createSession(sessionId), this.workdir)
  }

  /**
   * Where and as whom one command runs, settled before it starts: the
   * session binding, the workdir in this world, and its managed env.
   *
   * Seeding the env is the one step that writes, so it comes last and
   * waits for any seed already running on the same session (the bound
   * one and its read-only twin queue apart). Calls are numbered as they
   * arrive, and a seed is skipped once a later call has seeded the same
   * session, so the newest snapshot wins: a slow or abandoned preparation
   * never lands an old one over it, and a stall before the seed holds up
   * no other call. A call carrying no snapshot seeds nothing, so it
   * never counts as the newest, but it still waits for the seeds already
   * running, so its command never sees one half applied.
   *
   * @param spec the resolved spec being prepared.
   * @returns the workspace, session and workdir the command runs under.
   */
  private async prepare(spec: ShellExecSpec): Promise<Prepared> {
    const ticket = ++this.issued
    await this.ensureSession()
    const ws = await this.workspace()
    const sessionId = await this.sessionFor(spec)
    const bound = this.sessionId !== undefined
    const workdir = await this.worldWorkdir(spec)
    const managed = spec.dshEnv as Record<string, string> | undefined
    if (bound && sessionId !== undefined) {
      const running = this.seeding.get(sessionId) ?? Promise.resolve()
      if (managed === undefined) {
        await running
      } else {
        const seed = running.then(async () => {
          if (ticket < (this.seeded.get(sessionId) ?? 0)) return
          await this.applyManagedEnv(ws, sessionId, managed)
          this.seeded.set(sessionId, ticket)
        })
        this.seeding.set(
          sessionId,
          seed.catch(() => undefined),
        )
        await seed
      }
    }
    return { ws, sessionId, bound, workdir }
  }

  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const controller = new AbortController()
    let timedOut = false
    let aborted = false
    // `none` arms no deadline: the caller's signal and `kill()` are then
    // the only ways the command stops.
    const timer =
      spec.onExpiry === 'kill'
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, spec.timeoutMs)
        : undefined
    const onAbort = (): void => {
      if (!timedOut && !aborted) {
        aborted = true
        controller.abort()
      }
    }
    // An already-aborted signal never fires its listener, so it is
    // treated as fired here: the command must not run at all.
    if (spec.signal?.aborted === true) onAbort()
    else spec.signal?.addEventListener('abort', onAbort, { once: true })
    const disarm = (): void => {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
    const parts: ExecutionParts = {
      controller,
      budget: spec.stdoutMaxBytes,
      stdoutMaxBytes: spec.stdoutMaxBytes,
      stderrMaxBytes: this.stderrMaxBytes,
      timeoutMs: spec.timeoutMs,
      spill: this.newSpill(),
      classify: () => ({ timedOut, aborted }),
      verdict: (result, stderr) =>
        this.sandboxInfo(spec, result !== null && this.wasDenied(spec, result, stderr)),
      disarm,
    }
    let prepared: Prepared
    try {
      // The wait ends at the deadline or a cancel even if a step has
      // stalled; the preparation runs on, and its seed lands only if no
      // later call has seeded the session first.
      controller.signal.throwIfAborted()
      prepared = await untilAborted(this.prepare(spec), controller.signal)
    } catch (err) {
      // Expiry while the command was still being prepared settles a
      // timed-out handle with no output; a caller's cancellation or a
      // failure to prepare is the caller's to see.
      if (!parts.classify().timedOut) {
        disarm()
        throw err
      }
      return new MirageShellExecution(null, parts)
    }
    const { ws, sessionId, bound, workdir } = prepared
    return new MirageShellExecution(
      (sink) =>
        ws.shell(
          spec.command,
          executeOptions(spec, workdir, controller.signal, sessionId, bound, this.workdir, sink),
        ),
      parts,
    )
  }
}
