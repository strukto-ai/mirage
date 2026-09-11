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
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell'
import {
  Channel,
  JobConsole,
  KILLED_OUTCOME,
  RAMConsoleStore,
  exitOutcome,
} from '@struktoai/mirage-core/shell/console/index'
import type { ConsoleChunk } from '@struktoai/mirage-core/shell/console/index'
import { setCwd } from '@struktoai/mirage-core/workspace/session/shell_dirs'
import { sessionView } from '@struktoai/mirage-core/workspace/session/state'
import type {
  ExecuteOptions,
  ExecuteResult,
} from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { Workspace } from '@struktoai/mirage-node'
import { TailBuffer, tailCap } from './text.ts'
import { SpillSink, ensureDirPath, type SpillTarget } from './spill.ts'
import type {} from './service.ts'
import type { Refusal } from '@struktoai/mirage-core/types'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_STDOUT_MAX_BYTES = 200_000
const DEFAULT_STDERR_MAX_BYTES = 64_000
const STDERR_MARKER = new TextEncoder().encode('\n--- stderr ---\n')
// What a console may hold that its reader has not consumed yet. Capping
// the delta does not bound this: a reader's cursor advances but frees
// nothing, so an uncapped store keeps every chunk of a noisy command for
// the life of the process. Five deltas' worth, because a drain awaits the
// spill's own writes and has to be free to fall briefly behind, and
// bounded, so a command that outruns it forever cannot grow the heap.
// Derived from the call's own budget rather than fixed: a retention
// smaller than one delta would make a slow reader lossy by construction.
const CONSOLE_RETENTION_DELTAS = 5

// Monotonic within the process, so concurrent background commands never
// collide on a spill filename. Not reset, so it needs no time or randomness.
let spillCounter = 0

// The mount whose writability a `read-only` policy keeps, because dsh's
// own definition of that mode keeps it: "permits only required sinks such
// as /dev/null". Narrowing it too would make `cmd > /dev/null` fail, which
// no read-only sandbox anywhere does.
const SINK_PREFIX = '/dev'

// How mirage refuses a write the session's mount grants do not allow.
// Three spellings, because the refusal is raised in two places: a command
// names the mount it would not write to, while a redirection or an op below
// the granted mode is refused in the read-only voice as the file opens.
// Hide refusals keep `Permission denied`. Only consulted for a call that
// ran under `read-only`, so the only permission error these can catch is
// the one this executor just imposed.
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

function collect(text: string, maxBytes: number): CollectedOutput {
  const capped = tailCap(text, maxBytes)
  return { text: capped.text, truncated: capped.truncated }
}

function executeOptions(
  spec: ShellExecSpec,
  workdir: string,
  signal: AbortSignal,
  sessionId: string | undefined,
  bound: boolean,
  fallbackWorkdir: string,
  sink?: JobConsole,
): ExecuteOptions & { provision?: false } {
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

/**
 * A background command over the workspace executor, streamed through a
 * `JobConsole`. The command runs with the console as its `sink`, so each
 * statement of a compound line lands as it finishes rather than the whole
 * line arriving at the end (a single command still shows up in one chunk,
 * having nothing to emit before it completes). A background follow loop
 * drains the console into `pending`, which `readOutput()` hands back and
 * clears — consuming, so consecutive reads never re-deliver. Unread output
 * is bounded to `budget` bytes: the head is dropped and `lossy` set once
 * it overruns, keeping the tail, which is where the full stream spills to
 * a file. Both ends of the conduit are bounded, because draining the
 * console does not free it: the console holds a retention budget of its
 * own, and a command that outruns this loop by that much loses chunks,
 * which arrives here as a gap in the sequence. `kill()` aborts
 * cooperatively (the executor observes the signal between pipeline stages
 * and inside sleep).
 */
class MirageShellProcess implements ShellProcess {
  status: ShellProcessStatus = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  sandbox?: ShellSandboxInfo
  readonly done: Promise<void>

  private readonly controller: AbortController
  private readonly console: JobConsole
  private readonly budget: number
  private readonly spill: SpillSink | null
  private readonly sandboxInfo: ShellSandboxInfo | undefined
  private readonly consumed: Promise<void>
  private readonly pending: TailBuffer
  private lossy = false
  private inStderr = false
  private settled = false
  private expectSeq = 0

  constructor(
    run: Promise<ExecuteResult>,
    controller: AbortController,
    console_: JobConsole,
    budget: number,
    spill: SpillSink | null,
    sandboxInfo: ShellSandboxInfo | undefined,
  ) {
    this.controller = controller
    this.console = console_
    this.budget = budget
    this.pending = new TailBuffer(budget)
    this.spill = spill
    this.sandboxInfo = sandboxInfo
    this.consumed = this.consume()
    this.done = run.then(
      (result) => this.settle(result, null),
      (err: unknown) => this.settle(null, err),
    )
  }

  private async consume(): Promise<void> {
    // follow() yields every chunk in sequence and ends on the CONTROL
    // chunk that finish() appends.
    for await (const chunk of this.console.follow(0)) {
      if (chunk.channel === Channel.CONTROL) return
      // A seq that skips means the console trimmed chunks this loop had
      // not read: the command outran the drain by a whole retention
      // budget. Those bytes are gone for good, so say so, and stop the
      // spill rather than let a file with a hole in it be handed back
      // as the full stream.
      if (chunk.seq !== this.expectSeq) {
        this.lossy = true
        this.spill?.disable()
      }
      this.expectSeq = chunk.seq + 1
      await this.appendChunk(chunk)
    }
  }

  private async appendChunk(chunk: ConsoleChunk): Promise<void> {
    // The full, uncapped stream goes to the spill sink (if enabled)
    // before the delta is capped, so nothing dropped from the delta is
    // lost to a reader that follows the spill path.
    if (this.spill !== null) await this.spill.ingest(chunk.channel, chunk.data)
    // stderr rides the same delta as stdout, opened by a marker so the
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
    // freshest output), matching what the buffered path did at completion.
    dropped = this.pending.append(chunk.data) || dropped
    if (dropped) {
      this.lossy = true
      // The delta just dropped bytes; move the full stream to files so
      // the reader can still recover them from the spill path.
      if (this.spill !== null) await this.spill.begin()
    }
  }

  private async settle(result: ExecuteResult | null, err: unknown): Promise<void> {
    this.settled = true
    if (this.sandboxInfo !== undefined) this.sandbox = this.sandboxInfo
    let outcome: string
    if (result !== null) {
      this.status = 'completed'
      this.exitCode = result.exitCode
      outcome = exitOutcome(result.exitCode)
    } else {
      this.status = 'killed'
      this.signal = 'SIGTERM'
      const message = err instanceof Error ? err.message : String(err)
      await this.console.emit(Channel.STDERR, new TextEncoder().encode(message))
      outcome = KILLED_OUTCOME
    }
    // The CONTROL chunk ends the follow loop; awaiting `consumed`
    // guarantees every chunk (the last one included) has landed in
    // `pending` before `done` resolves, so a read after `done` is whole.
    await this.console.finish(outcome)
    await this.consumed
  }

  readOutput(): ShellProcessRead {
    const delta = this.pending.take()
    const lossy = this.lossy
    this.lossy = false
    return {
      delta,
      lossy,
      ...(this.spill?.stdoutPath !== undefined ? { stdoutSpillPath: this.spill.stdoutPath } : {}),
      ...(this.spill?.stderrPath !== undefined ? { stderrSpillPath: this.spill.stderrPath } : {}),
    }
  }

  kill(): boolean {
    if (this.settled) return false
    this.controller.abort()
    return true
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
    if (await ws.fs.isDir(spec.workdir)) return spec.workdir
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
        await ensureDirPath({ exists: (p) => ws.fs.exists(p), mkdir: (p) => ws.fs.mkdir(p) }, d)
      },
      write: async (p, bytes) => {
        const ws = await this.workspace()
        await ws.fs.writeFile(p, bytes)
      },
      append: async (p, bytes) => {
        const ws = await this.workspace()
        await ws.fs.append(p, bytes)
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
   * holding a runtime with doors around the gate (the host `local`
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
   * The retention budget of a background command's console.
   *
   * Only the background path caps retention: there a follow loop drains
   * the console while the command still runs, so the budget bounds what
   * the loop has not reached yet, and a chunk lost to it is reported as
   * a gap in the sequence. A foreground console is read once, after the
   * fact, with nothing to bound.
   *
   * @param spec the resolved spec carrying the stdout budget.
   * @returns the retention budget in bytes.
   */
  private retentionFor(spec: ShellExecSpec): number {
    return Math.max(spec.stdoutMaxBytes, this.stderrMaxBytes) * CONSOLE_RETENTION_DELTAS
  }

  /**
   * Take a finished run's two streams off its console, capped, and spill
   * whichever one lost bytes.
   *
   * A foreground run streams into a console rather than returning its
   * output whole, because mirage throws on abort: bytes a killed command
   * had already printed are recoverable from a sink and nowhere else.
   * Only a truncated stream spills, since an untruncated one is already
   * whole in `text` and writing a file for it would put a copy of every
   * command's output on a mount. The console this reads is untrimmed, so
   * a spill is the whole stream rather than the tail of one.
   *
   * @param console_ the console this run streamed into.
   * @param spec the resolved spec carrying the stdout budget.
   * @returns the capped streams, each with a spill path when it lost bytes.
   */
  private async collectFrom(
    console_: JobConsole,
    spec: ShellExecSpec,
  ): Promise<{ stdout: CollectedOutput; stderr: CollectedOutput }> {
    const decoder = new TextDecoder()
    const outBytes = await console_.snapshot(Channel.STDOUT)
    const errBytes = await console_.snapshot(Channel.STDERR)
    const stdout = collect(decoder.decode(outBytes), spec.stdoutMaxBytes)
    const stderr = collect(decoder.decode(errBytes), this.stderrMaxBytes)
    if (!stdout.truncated && !stderr.truncated) return { stdout, stderr }
    const spill = this.newSpill()
    if (spill === null) return { stdout, stderr }
    if (stdout.truncated) await spill.ingest(Channel.STDOUT, outBytes)
    if (stderr.truncated) await spill.ingest(Channel.STDERR, errBytes)
    await spill.begin()
    return {
      stdout: {
        ...stdout,
        ...(spill.stdoutPath !== undefined ? { spillPath: spill.stdoutPath } : {}),
      },
      stderr: {
        ...stderr,
        ...(spill.stderrPath !== undefined ? { spillPath: spill.stderrPath } : {}),
      },
    }
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
   * @param spec the resolved spec carrying the snapshot.
   */
  private async applyManagedEnv(
    ws: Workspace,
    sessionId: string,
    spec: ShellExecSpec,
  ): Promise<void> {
    const managed = spec.dshEnv as Record<string, string> | undefined
    if (managed === undefined) return
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
      grants[entry.prefix] = entry.prefix.replace(/\/+$/, '') === SINK_PREFIX ? 'exec' : 'read'
    }
    const hide = [...(source.hiddenPaths?.paths ?? []), ...(source.hiddenPaths?.patterns ?? [])]
    const twin = ws.createSession(sessionId, {
      mounts: grants,
      ...(hide.length > 0 ? { permissions: { paths: { hide } } } : {}),
    })
    twin.commands = source.commands
    twin.hiddenVars = source.hiddenVars
    setCwd(twin, this.workdir)
    return sessionId
  }

  private async provisionSession(sessionId: string): Promise<void> {
    const ws = await this.workspace()
    await ws.ensureSessionsLoaded()
    if (ws.listSessions().some((s) => s.sessionId === sessionId)) return
    setCwd(ws.createSession(sessionId), this.workdir)
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const sandbox = this.sandboxInfo(spec)
    // An already-aborted signal never fires its listener, so answer before
    // dispatch: the command must not run at all.
    if (spec.signal?.aborted === true) {
      return {
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: false,
        aborted: true,
        timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
        ...(sandbox !== undefined ? { sandbox } : {}),
      }
    }
    const controller = new AbortController()
    // The command streams into a console instead of returning its output
    // whole, because mirage answers an abort by throwing: what a killed
    // command already printed survives only in a sink.
    //
    // Retention is deliberately unbounded here, unlike the background
    // console: nothing drains this one, `collectFrom` reads it once the
    // command is over, and the store evicts whole chunks, so a budget
    // would silently drop an entire buffered stream larger than itself
    // and report empty output as untruncated. Holding the full stream
    // for the length of one call is what the executor did anyway before
    // a sink was attached, and it is what lets a truncated run spill
    // every byte rather than only the tail a budget kept.
    const console_ = new JobConsole(new RAMConsoleStore(null))
    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, spec.timeoutMs)
    const onAbort = (): void => {
      if (!timedOut && !aborted) {
        aborted = true
        controller.abort()
      }
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.ensureSession()
      const ws = await this.workspace()
      const sessionId = await this.sessionFor(spec)
      const bound = this.sessionId !== undefined
      if (bound && sessionId !== undefined) await this.applyManagedEnv(ws, sessionId, spec)
      const workdir = await this.worldWorkdir(spec)
      const result = await ws.execute(
        spec.command,
        executeOptions(spec, workdir, controller.signal, sessionId, bound, this.workdir, console_),
      )
      const captured = await this.collectFrom(console_, spec)
      const settled = this.sandboxInfo(spec, this.wasDenied(spec, result, captured.stderr.text))
      return {
        exitCode: result.exitCode,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        ...captured,
        ...(settled !== undefined ? { sandbox: settled } : {}),
      }
    } catch (err) {
      if (!controller.signal.aborted) throw err
      // The fused deadline was the first cause: report the kill as a
      // result, never a rejection, per the seam contract.
      return {
        exitCode: null,
        signal: 'SIGTERM',
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        // Whatever the command printed before the kill landed. GNU's own
        // timeout keeps it, and a model that watched a build run for two
        // minutes is owed the log rather than an empty string.
        ...(await this.collectFrom(console_, spec)),
        ...(sandbox !== undefined ? { sandbox } : {}),
      }
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    // A background handle has no aggregated stderr to read a denial back
    // off, so its facts carry the mode without the verdict; a reader that
    // needs it sees the refusal in the streamed output.
    const sandbox = this.sandboxInfo(spec)
    const controller = new AbortController()
    // The console is the streaming conduit, holding what the follow loop
    // has not drained yet (nothing, when the loop keeps up). Its own
    // retention budget is what bounds that, since reading a chunk does
    // not release it.
    const console_ = new JobConsole(new RAMConsoleStore(this.retentionFor(spec)))
    const spill = this.newSpill()
    if (spec.signal?.aborted === true) {
      controller.abort()
      return new MirageShellProcess(
        Promise.reject(new Error('command aborted before start')),
        controller,
        console_,
        spec.stdoutMaxBytes,
        spill,
        sandbox,
      )
    }
    const onAbort = (): void => {
      controller.abort()
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    const run = this.ensureSession()
      .then(async () => {
        const sessionId = await this.sessionFor(spec)
        const ws = await this.workspace()
        const bound = this.sessionId !== undefined
        if (bound && sessionId !== undefined) await this.applyManagedEnv(ws, sessionId, spec)
        return { ws, sessionId, bound, workdir: await this.worldWorkdir(spec) }
      })
      .then(({ ws, sessionId, bound, workdir }) =>
        ws.execute(
          spec.command,
          executeOptions(
            spec,
            workdir,
            controller.signal,
            sessionId,
            bound,
            this.workdir,
            console_,
          ),
        ),
      )
      .finally(() => spec.signal?.removeEventListener('abort', onAbort))
    return new MirageShellProcess(run, controller, console_, spec.stdoutMaxBytes, spill, sandbox)
  }
}
