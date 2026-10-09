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

import { getCurrentSession } from '@struktoai/mirage-core/context/session_context'
import { PROCESS_EXECUTOR, type ProcessExecutor } from '@struktoai/mirage-core/runtime/mixin'
import { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type { ProcessExecution, RunResult } from '@struktoai/mirage-core/runtime/types'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import {
  APPLE_CONTAINER_CONFIG_KEYS,
  type AppleContainerConfig,
  validateAppleContainerConfig,
} from './config.ts'
import {
  APPLE_CONTAINER_CLI_HINT,
  PRELUDE,
  RUNNING_STATE,
  noContainerHint,
  notRunningHint,
} from './constants.ts'
import { type CliResult, runCli } from '../cli.ts'

/**
 * Containers under Apple's `container` tool as a whole-line runtime.
 *
 * You start the containers yourself; mirage only connects to them and
 * execs lines. The `container` CLI is the transport, so there is no
 * SDK dependency and no XPC wiring; each line is one `container exec`
 * with the merged environment, the session cwd, real stdin, and
 * separated stderr.
 *
 * Each container is its own lightweight VM with its own Linux kernel,
 * so, as in a smolvm guest, the line sees nothing of the host's
 * filesystem except what the container was given at start
 * (`--volume`). Serve the workspace inside it at the host's mount
 * prefixes, the same contract every provider in this family carries.
 * The image needs a POSIX sh, which every argv runs under (PRELUDE).
 *
 * A line runs in its session's container (config `containers`, else
 * `container`), so one runtime can give every agent a VM of its own.
 * Each container is probed once, on its first line.
 */
export class AppleContainerRuntime
  extends RemoteSandbox<AppleContainerConfig>
  implements ProcessExecutor
{
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name = 'apple_container'
  private readonly probes = new Map<string, Promise<void>>()

  constructor(options: RuntimeOptions<AppleContainerConfig> | Record<string, unknown> = {}) {
    super(options, APPLE_CONTAINER_CONFIG_KEYS)
    validateAppleContainerConfig(this.config)
  }

  /** Run one container CLI invocation; the seam tests override. */
  protected container(
    args: string[],
    stdin: Uint8Array | null = null,
    signal?: AbortSignal,
  ): Promise<CliResult> {
    return runCli('container', APPLE_CONTAINER_CLI_HINT, args, stdin, signal)
  }

  /**
   * Attach nothing up front. Which container a line needs depends on its
   * session, so `target` probes each container on its first line instead.
   */
  connect(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Select this session's container. Concurrent first lines share a probe;
   * a failed probe clears its slot so the next line retries.
   */
  private async target(signal?: AbortSignal): Promise<string> {
    const sessionId = getCurrentSession()?.sessionId ?? null
    const { containers = {} } = this.config
    const mapped =
      sessionId !== null && Object.hasOwn(containers, sessionId) ? containers[sessionId] : undefined
    const container = mapped ?? this.config.container
    if (container === undefined) throw new Error(noContainerHint(sessionId))
    let probe = this.probes.get(container)
    if (probe === undefined) {
      probe = this.probe(container).catch((err: unknown) => {
        this.probes.delete(container)
        throw err
      })
      this.probes.set(container, probe)
    }
    await this.waitFor(probe, signal)
    return container
  }

  /**
   * Refuse a container in any state that cannot take a line.
   *
   * `container exec` refuses a container that is not running as well;
   * probing up front names the state and how to recover.
   */
  private async probe(container: string): Promise<void> {
    const result = await this.container(['inspect', container])
    if (result.code !== 0) {
      throw new Error(`container inspect failed: ${decode(result.stderr).trim()}`)
    }
    let state: unknown
    try {
      state = inspectedState(JSON.parse(decode(result.stdout)))
    } catch (error) {
      throw new Error(`container inspect returned unreadable json: ${String(error)}`)
    }
    if (state !== RUNNING_STATE) {
      throw new Error(notRunningHint(container, String(state)))
    }
  }

  async execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return this.execArgv(['sh', '-c', line], stdin, env, cwd, signal)
  }

  async runProcess(request: ProcessExecution): Promise<RunResult> {
    if (request.argv.length === 0) throw new Error('process argv must not be empty')
    return this.execArgv(
      request.argv,
      request.stdin,
      { ...this.config.env, ...request.env },
      request.cwd.virtual,
      request.signal,
    )
  }

  private async execArgv(
    argv: readonly string[],
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const container = await this.target(signal)
    const args = ['exec', '-i', '-w', '/']
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
    args.push(container, 'sh', '-c', PRELUDE, 'sh', cwd, ...argv)
    const result = await this.container(args, stdin, signal)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }
}

/** The first entry's `status.state`, throwing on any other shape. */
function inspectedState(payload: unknown): unknown {
  const entry: unknown = Array.isArray(payload) ? payload[0] : undefined
  const status: unknown =
    typeof entry === 'object' && entry !== null ? (entry as { status?: unknown }).status : undefined
  if (typeof status !== 'object' || status === null || !('state' in status)) {
    throw new Error('expected [{ status: { state } }]')
  }
  return status.state
}

const DECODER = new TextDecoder()

function decode(bytes: Uint8Array): string {
  return DECODER.decode(bytes)
}

registerRuntime('apple_container', AppleContainerRuntime)
