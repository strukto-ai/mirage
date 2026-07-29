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

import { ScriptSource, type RouteScript } from '../route/types.ts'
import { scriptStringError, type RunArgs, type RunResult, type Runtime } from '../runtime.ts'
import { coerceConfig, type NormalizedSandboxConfig, type SandboxConfig } from './config.ts'

/** Constructor options for a RemoteSandbox subclass (a yaml entry's keys). */
export interface RemoteSandboxOptions<C extends SandboxConfig = SandboxConfig> {
  /** Commands that place a whole line here; ["*"] claims every line. */
  captures?: readonly string[]
  /** How to reach the sandbox (a yaml entry's `config` block). */
  config?: C
  /** Per-line admission script, the same contract as any runtime. */
  script?: RouteScript
}

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
 * connects and execs lines. Subclasses adapt one provider by
 * implementing connect() and execLine(); routing, captures, and
 * per-line scripts are inherited.
 */
export abstract class RemoteSandbox<C extends SandboxConfig = SandboxConfig> implements Runtime {
  abstract readonly name: string
  readonly runsLines = true
  readonly captures: readonly string[]
  readonly config: NormalizedSandboxConfig<C>
  script?: RouteScript
  // Connect-once latch: the first captured line connects; later lines
  // just execute. Single-flight so concurrent first lines share one
  // connect, and a failed connect clears the slot so the next line
  // retries.
  private connecting: Promise<void> | null = null

  // Each provider passes its own config key list, so a field the
  // provider does not have fails loud (mirrors Python's config_cls).
  constructor(
    options: RemoteSandboxOptions<C> | Record<string, unknown> = {},
    configKeys?: readonly string[],
  ) {
    const opts = options as RemoteSandboxOptions<C>
    if (typeof opts.script === 'string') throw scriptStringError()
    this.captures = opts.captures !== undefined ? opts.captures.slice() : ['*']
    this.config = coerceConfig(opts.config, configKeys)
    if (typeof opts.script === 'function' || opts.script instanceof ScriptSource) {
      this.script = opts.script
    }
  }

  attach(): void {
    // the sandbox serves the workspace itself; nothing to wire
  }

  run(_args: RunArgs): Promise<RunResult> {
    return Promise.reject(
      new Error(
        `runtime '${this.name}' runs whole lines in a remote sandbox, ` +
          `not single interpreter stages`,
      ),
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
  close(): Promise<void> {
    return Promise.resolve()
  }
}
