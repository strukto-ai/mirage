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
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
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
import { Channel, JobConsole, RAMConsoleStore, exitOutcome, KILLED_OUTCOME } from '@struktoai/mirage-core'
import type { ConsoleChunk, ExecuteOptions, ExecuteResult } from '@struktoai/mirage-core'
import type { Workspace } from '@struktoai/mirage-node'
import { tailCap } from './text.ts'
import type {} from './service.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_STDOUT_MAX_BYTES = 200_000
const DEFAULT_STDERR_MAX_BYTES = 64_000
const STDERR_MARKER = '\n--- stderr ---\n'

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
   * existing session is adopted as is. A spec carrying an explicit
   * `workdir` or `env` still runs as a one-call subshell of the bound
   * session, per mirage's `ExecuteOptions` semantics.
   */
  sessionId?: string
}

function collect(text: string, maxBytes: number): CollectedOutput {
  const capped = tailCap(text, maxBytes)
  return { text: capped.text, truncated: capped.truncated }
}

function executeOptions(
  spec: ShellExecSpec,
  signal: AbortSignal,
  sessionId: string | undefined,
  fallbackWorkdir: string,
  sink?: JobConsole,
): ExecuteOptions & { provision?: false } {
  const env = {
    ...(spec.env ?? {}),
    ...((spec.dshEnv as Record<string, string> | undefined) ?? {}),
  }
  // Unbound, `cwd` is always present so every command runs in an ephemeral
  // fork of the default session: isolation must not hinge on a spec
  // happening to carry a workdir. Bound, an absent workdir runs in the
  // session itself, which is what lets its state persist.
  const cwd =
    spec.workdir !== '' ? spec.workdir : sessionId === undefined ? fallbackWorkdir : undefined
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
 * a file. `kill()` aborts cooperatively (the executor observes the signal
 * between pipeline stages and inside sleep).
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
  private readonly sandboxInfo: ShellSandboxInfo | undefined
  private readonly consumed: Promise<void>
  private pending = ''
  private lossy = false
  private inStderr = false
  private settled = false

  constructor(
    run: Promise<ExecuteResult>,
    controller: AbortController,
    console_: JobConsole,
    budget: number,
    sandboxInfo: ShellSandboxInfo | undefined,
  ) {
    this.controller = controller
    this.console = console_
    this.budget = budget
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
      this.appendChunk(chunk)
    }
  }

  private appendChunk(chunk: ConsoleChunk): void {
    const text = new TextDecoder().decode(chunk.data)
    // stderr rides the same delta as stdout, opened by a marker so the
    // reader can tell the two apart; a run of stderr chunks marks once.
    if (chunk.channel === Channel.STDERR) {
      if (!this.inStderr) {
        this.pending += STDERR_MARKER
        this.inStderr = true
      }
      this.pending += text
    } else {
      this.inStderr = false
      this.pending += text
    }
    // Bound the unread backlog: a reader that never drains cannot grow
    // `pending` without limit. The tail is kept (the freshest output),
    // matching what the buffered path did at completion.
    const capped = tailCap(this.pending, this.budget)
    if (capped.truncated) {
      this.pending = capped.text
      this.lossy = true
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
    const delta = this.pending
    this.pending = ''
    const lossy = this.lossy
    this.lossy = false
    return { delta, lossy }
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
  private sessionReady: Promise<void> | null = null

  constructor(ctx: Context, config: MirageShellConfig = {}) {
    super(ctx)
    this.workdir = config.workdir ?? '/'
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTimeoutMs = config.maxTimeoutMs ?? MAX_TIMEOUT_MS
    this.stdoutMaxBytes = config.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES
    this.stderrMaxBytes = config.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES
    this.sessionId = config.sessionId
  }

  // The workspace may still be building (declarative mounts resolve
  // asynchronously), so every execution awaits the service's `ready`.
  private workspace(): Promise<Workspace> {
    return this.ctx.mirage.ready
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
   * The sandbox facts to stamp on this run's result and process handle,
   * or undefined when the world is not fully workspace-bound (no claim).
   *
   * `enforcement` is 'full': when every runtime reaches only the vfs, the
   * workspace gate cannot be bypassed, so unlike an OS sandbox on an older
   * kernel there is no promised effect it fails to govern. `denied` is
   * false because mirage has no out-of-band denial channel: a refused write
   * (a read-only mount) fails in-band as an ordinary command error with a
   * nonzero exit, the way EROFS would, not as a separate sandbox verdict,
   * so there is nothing here to distinguish from the command's own failure.
   * `runnerFailed` is false because the workspace executor is the runner
   * and a failure to run surfaces as a rejected/aborted execution, not a
   * runner that never started.
   */
  private sandboxInfo(): ShellSandboxInfo | undefined {
    const mode = this.sandboxMode
    if (mode === undefined) return undefined
    return { mode, denied: false, enforcement: 'full', runnerFailed: false }
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

  private async provisionSession(sessionId: string): Promise<void> {
    const ws = await this.workspace()
    await ws.ensureSessionsLoaded()
    if (ws.listSessions().some((s) => s.sessionId === sessionId)) return
    const session = ws.createSession(sessionId)
    session.cwd = this.workdir
    session.env.PWD = this.workdir
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const sandbox = this.sandboxInfo()
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
      const result = await ws.execute(
        spec.command,
        executeOptions(spec, controller.signal, this.sessionId, this.workdir),
      )
      return {
        exitCode: result.exitCode,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: collect(result.stdoutText, spec.stdoutMaxBytes),
        stderr: collect(result.stderrText, this.stderrMaxBytes),
        ...(sandbox !== undefined ? { sandbox } : {}),
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
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
        ...(sandbox !== undefined ? { sandbox } : {}),
      }
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    const sandbox = this.sandboxInfo()
    const controller = new AbortController()
    // The console is the streaming conduit; the process bounds the unread
    // backlog itself, so the store keeps everything the follow loop has
    // not drained yet (which stays small when a reader keeps up).
    const console_ = new JobConsole(new RAMConsoleStore())
    if (spec.signal?.aborted === true) {
      controller.abort()
      return new MirageShellProcess(
        Promise.reject(new Error('command aborted before start')),
        controller,
        console_,
        spec.stdoutMaxBytes,
        sandbox,
      )
    }
    const onAbort = (): void => {
      controller.abort()
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    const run = this.ensureSession()
      .then(() => this.workspace())
      .then((ws) =>
        ws.execute(
          spec.command,
          executeOptions(spec, controller.signal, this.sessionId, this.workdir, console_),
        ),
      )
      .finally(() => spec.signal?.removeEventListener('abort', onAbort))
    return new MirageShellProcess(run, controller, console_, spec.stdoutMaxBytes, sandbox)
  }
}
