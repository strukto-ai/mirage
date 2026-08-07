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

import { Runtime } from '../base.ts'
import { LINE_EXECUTOR, type LineExecutor } from '../mixin.ts'
import type { RunResult, RuntimeOptions } from '../types.ts'
import { BASE_CONFIG_KEYS, type NormalizedSandboxConfig, type SandboxConfig } from './config.ts'

/**
 * A runtime that runs whole lines inside a sandbox the user runs.
 *
 * Mirage never creates, provisions, or deletes sandboxes: you bring
 * your own (a running container, a live Daytona or E2B sandbox) and
 * the provider config says how to reach it. The sandbox is also
 * yours to provision: serve the workspace inside it yourself (run
 * `mirage workspace create` in the image entrypoint or by hand) with
 * mounts at the same prefixes as the host workspace, so the session
 * cwd and every path in a line resolve unchanged. Mirage only
 * connects and execs lines: the whole-line door is LineExecutor's
 * runLine, and there is no interpreter door. Subclasses adapt one
 * provider by implementing connect() and execLine(); routing,
 * captures, and per-line scripts are inherited. Constructed like
 * every runtime (captures, config, script); config is how to reach
 * the sandbox, coerced against the provider's own key list.
 */
export abstract class RemoteSandbox<C extends SandboxConfig = SandboxConfig>
  extends Runtime
  implements LineExecutor
{
  readonly [LINE_EXECUTOR] = true as const
  declare config: NormalizedSandboxConfig<C>
  // Connect-once latch: the first captured line connects; later lines
  // just execute. Single-flight so concurrent first lines share one
  // connect, and a failed connect clears the slot so the next line
  // retries.
  private connecting: Promise<void> | null = null

  constructor(
    options: RuntimeOptions<C> | Record<string, unknown> = {},
    configKeys?: readonly string[],
  ) {
    super(options as RuntimeOptions, ['*'], configKeys ?? BASE_CONFIG_KEYS)
    // The sandbox refinement of the base's coerced copy: the shared
    // collection fields are always present (env).
    const config = this.config as C
    this.config = { ...config, env: { ...config.env } }
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
  ): Promise<RunResult> {
    this.connecting ??= this.connect().catch((err: unknown) => {
      this.connecting = null
      throw err
    })
    await this.connecting
    const merged = { ...this.config.env, ...env }
    return this.execLine(line, stdin, merged, cwd)
  }

  /** Attach to the user's live sandbox, failing loud if absent. */
  abstract connect(): Promise<void>

  /** Execute one shell line inside the sandbox. */
  abstract execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult>

  /** Release provider client resources; the sandbox itself is the user's. */
  override close(): Promise<void> {
    return Promise.resolve()
  }
}
