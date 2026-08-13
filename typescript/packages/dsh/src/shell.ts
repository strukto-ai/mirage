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
} from '@deepseek-ai/dsh-shell'
import type { ExecuteOptions, ExecuteResult } from '@struktoai/mirage-core'
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
  }
}

/**
 * A background command over the workspace executor. mirage buffers a
 * command's whole output internally, so reads deliver everything at
 * completion rather than incrementally; `kill()` aborts cooperatively (the
 * executor observes the signal between pipeline stages and inside sleep).
 */
class MirageShellProcess implements ShellProcess {
  status: ShellProcessStatus = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  readonly done: Promise<void>

  private readonly controller: AbortController
  private readonly stdoutMaxBytes: number
  private readonly stderrMaxBytes: number
  private pending = ''
  private lossy = false
  private settled = false

  constructor(
    run: Promise<ExecuteResult>,
    controller: AbortController,
    stdoutMaxBytes: number,
    stderrMaxBytes: number,
  ) {
    this.controller = controller
    this.stdoutMaxBytes = stdoutMaxBytes
    this.stderrMaxBytes = stderrMaxBytes
    this.done = run.then(
      (result) => {
        this.finish(result)
      },
      (err: unknown) => {
        this.fail(err)
      },
    )
  }

  private finish(result: ExecuteResult): void {
    this.settled = true
    this.status = 'completed'
    this.exitCode = result.exitCode
    const stdout = collect(result.stdoutText, this.stdoutMaxBytes)
    const stderr = collect(result.stderrText, this.stderrMaxBytes)
    this.lossy = stdout.truncated || stderr.truncated
    this.pending += stdout.text
    if (stderr.text !== '') this.pending += STDERR_MARKER + stderr.text
  }

  private fail(err: unknown): void {
    this.settled = true
    this.status = 'killed'
    this.signal = 'SIGTERM'
    const message = err instanceof Error ? err.message : String(err)
    this.pending += STDERR_MARKER + message
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

  private readonly workspace: Workspace
  private readonly workdir: string
  private readonly defaultTimeoutMs: number
  private readonly maxTimeoutMs: number
  private readonly stdoutMaxBytes: number
  private readonly stderrMaxBytes: number
  private readonly sessionId: string | undefined
  private sessionReady: Promise<void> | null = null

  constructor(ctx: Context, config: MirageShellConfig = {}) {
    super(ctx)
    this.workspace = ctx.mirage.workspace
    this.workdir = config.workdir ?? '/'
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTimeoutMs = config.maxTimeoutMs ?? MAX_TIMEOUT_MS
    this.stdoutMaxBytes = config.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES
    this.stderrMaxBytes = config.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES
    this.sessionId = config.sessionId
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
    await this.workspace.ensureSessionsLoaded()
    if (this.workspace.listSessions().some((s) => s.sessionId === sessionId)) return
    const session = this.workspace.createSession(sessionId)
    session.cwd = this.workdir
    session.env.PWD = this.workdir
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
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
      const result = await this.workspace.execute(
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
      }
    } finally {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    const controller = new AbortController()
    if (spec.signal?.aborted === true) {
      controller.abort()
      return new MirageShellProcess(
        Promise.reject(new Error('command aborted before start')),
        controller,
        spec.stdoutMaxBytes,
        this.stderrMaxBytes,
      )
    }
    const onAbort = (): void => {
      controller.abort()
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    const run = this.ensureSession()
      .then(() =>
        this.workspace.execute(
          spec.command,
          executeOptions(spec, controller.signal, this.sessionId, this.workdir),
        ),
      )
      .finally(() => spec.signal?.removeEventListener('abort', onAbort))
    return new MirageShellProcess(run, controller, spec.stdoutMaxBytes, this.stderrMaxBytes)
  }
}
