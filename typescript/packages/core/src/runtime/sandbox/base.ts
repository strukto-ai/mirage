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

import type { Context } from '../../commands/config.ts'
import type { ByteSource } from '../../io/types.ts'
import type { PathSpec } from '../../types.ts'
import { EXTERNAL_COMMANDS } from '../constants.ts'
import { Runtime } from '../base.ts'
import {
  LINE_EXECUTOR,
  PROCESS_EXECUTOR,
  type LineExecutor,
  type ProcessExecutor,
} from '../mixin.ts'
import type { MountType, OutputFn, RunResult } from '../types.ts'
import type { RuntimeOptions } from '../config.ts'
import { abortable } from '../../utils/abort.ts'
import { currentCaller } from '../../context/session_context.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { shellJoin } from '../../shell/join.ts'
import {
  BASE_CONFIG_KEYS,
  checkMountType,
  type NormalizedSandboxConfig,
  type SandboxConfig,
} from './config.ts'
import {
  EXEC_ID,
  FAKETIME_PROBE_SECONDS,
  faketimeEnv,
  faketimeProbe,
  REAP_ABSENT,
  REAP_WAIT_SECONDS,
  reapLine,
} from './constants.ts'
import { boundSystemClock } from '../../utils/clock.ts'
import { isPipeTransport } from './mixin.ts'
import { SandboxMounts } from './mounts.ts'

/**
 * A runtime that executes programs in a sandbox the user runs.
 *
 * Captures default to unresolved program names. An explicit WHOLE_LINE
 * delegates whole shell lines.
 *
 * Mirage never creates, provisions, or deletes sandboxes: you bring
 * your own (a running container, a live Daytona or E2B sandbox) and
 * the provider config says how to reach it. The workspace reaches the
 * sandbox at the same prefixes as the host's, so the session cwd and
 * every path in a line resolve unchanged: a provider with a `mountType`
 * serves them itself (SandboxMounts), otherwise serve them inside it
 * yourself (`mirage workspace create` in the image entrypoint or by
 * hand). There is no interpreter entry point. Subclasses adapt one
 * provider by implementing connect() and execArgv(), and PipeTransport
 * for a `mountType`; every run derives from execArgv: a whole line runs
 * as `/bin/sh -c`, a program from its argv, and a stream hands its
 * output over as it comes. Routing and captures are inherited.
 * Constructed like every runtime (captures, config); config is
 * how to reach the sandbox, coerced against the provider's own key list.
 */
export abstract class RemoteSandbox<C extends SandboxConfig = SandboxConfig>
  extends Runtime<undefined>
  implements LineExecutor<undefined>, ProcessExecutor<undefined>
{
  // Lines execute on the provider's machine and act on that machine's
  // world (its filesystem, its network); the workspace gate never sees
  // those effects, however well isolated the sandbox itself is.
  override readonly reach = 'remote'
  readonly [LINE_EXECUTOR] = true as const
  readonly [PROCESS_EXECUTOR] = true as const
  declare config: NormalizedSandboxConfig<C>
  // Connect-once latch: the first captured line connects; later lines
  // just execute. Single-flight so concurrent first lines share one
  // connect, and a failed connect clears the slot so the next line
  // retries.
  private connecting: Promise<void> | null = null
  private mounts: SandboxMounts | null = null
  // The libfaketime each sandbox holds (`sandboxKey`), asked once the first
  // program runs there under a system_time: null for none. Concurrent first
  // runs share the probe; a failed probe clears its slot so a later run asks
  // again.
  private readonly faketime = new Map<string, Promise<string | null>>()

  constructor(options: RuntimeOptions<C> = {}, configKeys?: readonly string[]) {
    super(options as RuntimeOptions, [EXTERNAL_COMMANDS], configKeys ?? BASE_CONFIG_KEYS)
    // The sandbox refinement of the base's coerced copy: the shared
    // collection fields are always present (env).
    const config = this.config as C
    this.config = { ...config, env: { ...config.env } }
    checkMountType('sandbox', config.mountType)
  }

  override get fileEffectsDispatched(): boolean {
    return (
      this.mounts?.fileEffectsDispatched === true &&
      this.binding?.mountPrefixes != null &&
      !this.binding.mountPrefixes().includes('/')
    )
  }

  protected override servesSession(restrictedMounts: readonly string[]): boolean {
    return (
      (this.mounts !== null || this.config.mountType != null) &&
      restrictedMounts.every((prefix) => !['', '/dev'].includes(rstripSlash(prefix)))
    )
  }

  /**
   * Run one raw line in the sandbox, connecting once.
   *
   * The line, cwd, and paths pass through verbatim: the sandbox is
   * expected to serve the workspace at the same prefixes as the host,
   * so nothing is rewritten. The session environment merges over the
   * config environment.
   *
   * @param _engine none; a sandbox keeps its own connection.
   * @param _paths unused; the line names its paths.
   * @param _texts unused.
   * @param ctx the line in `flags.c`, the bytes piped into it, the session
   *   environment and working directory, the signal that stops it.
   * @param output receives stdout as it arrives.
   * @param errors receives stderr as it arrives.
   */
  runLine(
    _engine: undefined,
    _paths: PathSpec[],
    _texts: string[],
    ctx: Context,
    output?: OutputFn,
    errors?: OutputFn,
  ): Promise<RunResult> {
    const line = ctx.flags.c
    return this.runArgv(
      ['/bin/sh', '-c', typeof line === 'string' ? line : ''],
      ctx,
      output ?? null,
      errors ?? null,
    )
  }

  runProcess(
    _engine: undefined,
    _paths: PathSpec[],
    texts: string[],
    ctx: Context,
    output: OutputFn | undefined,
    errors?: OutputFn,
  ): Promise<RunResult> {
    return this.runArgv(texts, ctx, output ?? null, errors ?? null)
  }

  override async settle(): Promise<void> {
    await this.mounts?.sync()
  }

  /**
   * Connect once, bring the served mounts in step, then run.
   *
   * @param argv the program and its arguments.
   * @param ctx the run's stdin, environment, cwd and signal.
   * @param output receives stdout as it arrives.
   * @param errors receives stderr as it arrives.
   */
  private async runArgv(
    argv: readonly string[],
    ctx: Context,
    output: OutputFn | null,
    errors: OutputFn | null,
  ): Promise<RunResult> {
    // Served here rather than in the constructor, which runs before a
    // subclass names itself.
    if (this.mounts === null) this.serveMounts(this.config.mountType ?? null)
    await this.ensureConnected(ctx.signal)
    const refusal = (await this.mounts?.admit(this.binding, ctx.signal)) ?? null
    if (refusal !== null) return refusal
    const given = { ...this.config.env, ...ctx.env }
    const clock = await this.systemTimeEnv(given, ctx.signal)
    // A deadline that passed during the probe starts nothing.
    ctx.signal?.throwIfAborted()
    const execId = crypto.randomUUID().replaceAll('-', '')
    const runner = currentCaller().process
    runner?.addRun(`box:${execId}`, { runtime: this.name, tag: execId, command: shellJoin(argv) })
    try {
      return await this.execArgv(
        argv,
        ctx.stdin,
        { ...given, ...clock, [EXEC_ID]: execId },
        ctx.cwd.virtual,
        output,
        errors,
        ctx.signal,
      )
    } catch (error) {
      if (ctx.signal?.aborted === true) await this.reapRun(execId, runner?.signal ?? 15)
      throw error
    } finally {
      runner?.dropRun(`box:${execId}`)
    }
  }

  /**
   * Stop a run a lapsed workspace left in the box: every process its
   * `EXEC_ID` tag marks gets `signum`, then KILL a second later. Connecting
   * is bounded as the stop is (`REAP_WAIT_SECONDS`). Answers true once the
   * box held the run's processes and they were stopped, false when it holds
   * none of them, as a box other than the run's does; throws when the box
   * could not be reached or the stop failed.
   *
   * @param tag the run's `EXEC_ID`, as its process record has it.
   * @param signum the first signal.
   */
  async reap(tag: string, signum: number): Promise<boolean> {
    await this.ensureConnected(AbortSignal.timeout(REAP_WAIT_SECONDS * 1000))
    const code = await this.reapRun(tag, signum)
    if (code !== 0 && code !== REAP_ABSENT) throw new Error(`${this.name}: run ${tag} not stopped`)
    return code === 0
  }

  /**
   * Stop what a cancelled run left in the box (`EXEC_ID`), for at most
   * `REAP_WAIT_SECONDS`: a box that stopped answering would otherwise hold
   * the cancel.
   *
   * @param execId the run's id.
   * @param signum the signal the run is stopped with first.
   * @returns the stop line's status (`reapLine`); null when the box did not
   *   answer.
   */
  private async reapRun(execId: string, signum: number): Promise<number | null> {
    const signal = AbortSignal.timeout(REAP_WAIT_SECONDS * 1000)
    try {
      const done = await abortable(
        this.execArgv(
          ['/bin/sh', '-c', reapLine(execId, signum)],
          null,
          { ...this.config.env },
          '/',
          null,
          null,
          signal,
        ),
        signal,
      )
      if (done.exitCode !== 0 && done.exitCode !== REAP_ABSENT) {
        console.debug(`${this.name}: run ${execId} not stopped: exit ${String(done.exitCode)}`)
      }
      return done.exitCode
    } catch (error) {
      console.debug(`${this.name}: run ${execId} not stopped: ${String(error)}`)
      return null
    }
  }

  /** Let the sandbox see the workspace by `mountType`; null serves nothing. */
  private serveMounts(mountType: MountType | null): void {
    if (mountType === null) return
    if (!isPipeTransport(this)) throw new Error(`${this.name}: mountType needs a pipe transport`)
    this.mounts = new SandboxMounts(
      this.name,
      mountType,
      (line, signal) => this.execLine(line, null, { ...this.config.env }, '/', signal),
      this.openPipe.bind(this),
    )
  }

  protected disconnected(): void {
    this.connecting = null
  }

  /**
   * What a program in this sandbox needs to read the running workspace's
   * system time (`faketimeEnv`), through the libfaketime the sandbox holds.
   * Empty when the workspace keeps the host's time, and when the sandbox has
   * no libfaketime, where the program runs on the sandbox's clock. Mirrors
   * Python's `SandboxRuntime._system_time_env`.
   */
  private async systemTimeEnv(
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Record<string, string>> {
    if (boundSystemClock() === null) return {}
    const key = this.sandboxKey()
    let probe = this.faketime.get(key)
    if (probe === undefined) {
      // Its own deadline, not the first caller's: every waiting run shares it.
      // It is also raced, as a provider may not stop a line on its signal.
      const deadline = AbortSignal.timeout(FAKETIME_PROBE_SECONDS * 1000)
      probe = abortable(
        this.execLine(faketimeProbe(), null, { ...this.config.env }, '/', deadline),
        deadline,
      ).then((found) => {
        if (found.exitCode !== 0)
          throw new Error(`${this.name}: libfaketime probe exited ${String(found.exitCode)}`)
        return new TextDecoder().decode(found.stdout).trim() || null
      })
      this.faketime.set(key, probe)
    }
    let library: string | null
    try {
      library = await abortable(probe, signal)
    } catch (err) {
      // This run's own deadline: the probe goes on for the others.
      if (signal?.aborted === true) throw err
      // Unanswered: this run keeps the sandbox's clock, and a later one asks again.
      if (this.faketime.get(key) === probe) this.faketime.delete(key)
      return {}
    }
    return library === null ? {} : faketimeEnv(library, env)
  }

  /**
   * Which sandbox a run of the current session goes to, which the libfaketime
   * probe is kept for: one per runtime unless a provider picks its sandbox
   * per session. Mirrors Python's `SandboxRuntime._sandbox_key`.
   */
  protected sandboxKey(): string {
    return ''
  }

  protected async ensureConnected(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.connecting ??= this.connect().catch((err: unknown) => {
      this.connecting = null
      throw err
    })
    await abortable(this.connecting, signal)
    signal?.throwIfAborted()
  }

  /** Attach to the user's live sandbox, failing loud if absent. */
  abstract connect(): Promise<void>

  /**
   * Execute one argv inside the sandbox: the provider's transport.
   *
   * @param argv the program and its arguments.
   * @param stdin the input, read as the program consumes it; null for none.
   * @param env the merged environment.
   * @param cwd the working directory, passed through verbatim.
   * @param output receives stdout as it arrives, which the result then
   *   leaves out; null, or a transport that cannot stream, returns it whole.
   * @param errors the same for stderr.
   * @param signal stops the program.
   */
  protected abstract execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult>

  /**
   * Execute one shell line inside the sandbox, as `/bin/sh -c`.
   *
   * @param line the raw shell line.
   * @param stdin bytes piped into the line.
   * @param env the merged environment.
   * @param cwd the working directory, passed through verbatim.
   * @param signal stops the line.
   */
  execLine(
    line: string,
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return this.execArgv(['/bin/sh', '-c', line], stdin, env, cwd, null, null, signal)
  }

  /** Unmount what the sandbox was served; the sandbox itself is the user's. */
  override async close(): Promise<void> {
    await this.mounts?.close()
    await super.close()
  }
}
