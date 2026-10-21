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
  STREAMING_PROCESS,
  type LineExecutor,
  type StreamingProcess,
} from '../mixin.ts'
import type { MountType, OutputFn, RunResult } from '../types.ts'
import type { RuntimeOptions } from '../config.ts'
import { abortable } from '../../utils/abort.ts'
import { rstripSlash } from '../../utils/slash.ts'
import {
  BASE_CONFIG_KEYS,
  checkMountType,
  type NormalizedSandboxConfig,
  type SandboxConfig,
} from './config.ts'
import { isPipeTransport } from './mixin.ts'
import { SandboxMounts } from './mounts.ts'

/**
 * A runtime that executes programs in a sandbox the user runs.
 *
 * Captures default to unresolved program names. An explicit "*"
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
  implements LineExecutor<undefined>, StreamingProcess<undefined>
{
  // Lines execute on the provider's machine and act on that machine's
  // world (its filesystem, its network); the workspace gate never sees
  // those effects, however well isolated the sandbox itself is.
  override readonly reach = 'remote'
  readonly [LINE_EXECUTOR] = true as const
  readonly [PROCESS_EXECUTOR] = true as const
  readonly [STREAMING_PROCESS] = true as const
  declare config: NormalizedSandboxConfig<C>
  // Connect-once latch: the first captured line connects; later lines
  // just execute. Single-flight so concurrent first lines share one
  // connect, and a failed connect clears the slot so the next line
  // retries.
  private connecting: Promise<void> | null = null
  private mounts: SandboxMounts | null = null

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
   */
  runLine(
    _engine: undefined,
    _paths: PathSpec[],
    _texts: string[],
    ctx: Context,
  ): Promise<RunResult> {
    const line = ctx.flags.c
    return this.runArgv(['/bin/sh', '-c', typeof line === 'string' ? line : ''], ctx, null)
  }

  runProcess(
    _engine: undefined,
    _paths: PathSpec[],
    texts: string[],
    ctx: Context,
  ): Promise<RunResult> {
    return this.runArgv(texts, ctx, null)
  }

  runStream(
    _engine: undefined,
    _paths: PathSpec[],
    texts: string[],
    ctx: Context,
    output: OutputFn,
  ): Promise<RunResult> {
    return this.runArgv(texts, ctx, output)
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
   */
  private async runArgv(
    argv: readonly string[],
    ctx: Context,
    output: OutputFn | null,
  ): Promise<RunResult> {
    // Served here rather than in the constructor, which runs before a
    // subclass names itself.
    if (this.mounts === null) this.serveMounts(this.config.mountType ?? null)
    await this.ensureConnected(ctx.signal)
    const refusal = (await this.mounts?.admit(this.binding, ctx.signal)) ?? null
    if (refusal !== null) return refusal
    return this.execArgv(
      argv,
      ctx.stdin,
      { ...this.config.env, ...ctx.env },
      ctx.cwd.virtual,
      output,
      ctx.signal,
    )
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
   * @param signal stops the program.
   */
  protected abstract execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
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
    return this.execArgv(['/bin/sh', '-c', line], stdin, env, cwd, null, signal)
  }

  /** Unmount what the sandbox was served; the sandbox itself is the user's. */
  override async close(): Promise<void> {
    await this.mounts?.close()
    await super.close()
  }
}
