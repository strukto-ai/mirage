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

import { EXTERNAL_COMMANDS } from '../constants.ts'
import { Runtime } from '../base.ts'
import type { RuntimeContext } from '../binding.ts'
import { LINE_EXECUTOR, type LineExecutor } from '../mixin.ts'
import type { MountType, ProcessExecution, RunResult, SandboxPipe } from '../types.ts'
import type { RuntimeOptions } from '../config.ts'
import { abortable } from '../../utils/abort.ts'
import { rstripSlash } from '../../utils/slash.ts'
import {
  BASE_CONFIG_KEYS,
  checkMountType,
  type NormalizedSandboxConfig,
  type SandboxConfig,
} from './config.ts'
import { SandboxMounts } from './mounts.ts'

const ENC = new TextEncoder()

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
 * hand). The whole-line entry point is LineExecutor's runLine, and there
 * is no interpreter entry point. Subclasses adapt one provider by
 * implementing connect() and execLine(), and openPipe() for a
 * `mountType`; routing and captures are inherited.
 * Constructed like every runtime (captures, config); config is
 * how to reach the sandbox, coerced against the provider's own key list.
 */
export abstract class RemoteSandbox<C extends SandboxConfig = SandboxConfig>
  extends Runtime
  implements LineExecutor
{
  // Lines execute on the provider's machine and act on that machine's
  // world (its filesystem, its network); the workspace gate never sees
  // those effects, however well isolated the sandbox itself is.
  override readonly reach = 'remote'
  readonly [LINE_EXECUTOR] = true as const
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
    const mountType = checkMountType('sandbox', config.mountType)
    if (mountType !== null && this.openPipe === RemoteSandbox.prototype.openPipe)
      throw new Error('sandbox: mountType needs a pipe transport')
  }

  override get fileEffectsDispatched(): boolean {
    return (
      this.mounts?.fileEffectsDispatched === true &&
      this.binding?.mountPrefixes != null &&
      !this.binding.mountPrefixes().includes('/')
    )
  }

  protected override servesSession(context: RuntimeContext): boolean {
    return (
      (this.mounts !== null || this.config.mountType != null) &&
      (context.restrictedMounts ?? []).every(
        (prefix) => !['', '/dev'].includes(rstripSlash(prefix)),
      )
    )
  }

  /**
   * Run one raw line in the sandbox, connecting once.
   *
   * The line, cwd, and paths pass through verbatim: the sandbox is
   * expected to serve the workspace at the same prefixes as the host,
   * so nothing is rewritten. The session environment merges over the
   * config environment.
   */
  async runLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const refusal = await this.prepare(signal)
    if (refusal !== null) return refusal
    const merged = { ...this.config.env, ...env }
    return this.execLine(line, stdin, merged, cwd, signal)
  }

  async runProcess(request: ProcessExecution): Promise<RunResult> {
    const refusal = await this.prepare(request.signal)
    if (refusal !== null) return refusal
    return this.execArgv(
      request.argv,
      request.stdin,
      { ...this.config.env, ...request.env },
      request.cwd.virtual,
      request.signal,
    )
  }

  private async prepare(signal?: AbortSignal): Promise<RunResult | null> {
    await this.ensureConnected(signal)
    const refusal = await this.mounts?.admit(this.binding, signal)
    return refusal == null
      ? null
      : { stdout: new Uint8Array(), stderr: ENC.encode(`${this.name}: ${refusal}\n`), exitCode: 1 }
  }

  protected execArgv(
    _argv: readonly string[],
    _stdin: Uint8Array | null,
    _env: Record<string, string>,
    _cwd: string,
    _signal?: AbortSignal,
  ): Promise<RunResult> {
    return Promise.reject(new Error(`${this.name}: argv execution is unsupported`))
  }

  /** Let the sandbox see the workspace by `mountType`; null serves nothing. */
  protected serveMounts(mountType: MountType | null): void {
    if (mountType === null) return
    this.mounts = new SandboxMounts(
      this.name,
      mountType,
      (line, signal) => this.execLine(line, null, { ...this.config.env }, '/', signal),
      (command) => this.openPipe(command),
    )
  }

  protected disconnected(): void {
    this.connecting = null
  }

  protected async ensureConnected(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.mounts === null) this.serveMounts(this.config.mountType ?? null)
    this.connecting ??= this.connect().catch((err: unknown) => {
      this.connecting = null
      throw err
    })
    await abortable(this.connecting, signal)
    signal?.throwIfAborted()
  }

  /** Attach to the user's live sandbox, failing loud if absent. */
  abstract connect(): Promise<void>

  /** Execute one shell line inside the sandbox. */
  execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return this.execArgv(['sh', '-c', line], stdin, env, cwd, signal)
  }

  /**
   * Start a command in the sandbox with its stdin and stdout held open,
   * byte for byte, for a `mountType`'s SFTP.
   */
  openPipe(_command: string): Promise<SandboxPipe> {
    return Promise.reject(new Error(`${this.name}: this sandbox holds no pipe open`))
  }

  /** Unmount what the sandbox was served; the sandbox itself is the user's. */
  override async close(): Promise<void> {
    await this.mounts?.close()
  }
}
