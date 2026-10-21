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

import { PROCESS_EXECUTOR, type ProcessExecutor } from '@struktoai/mirage-core/runtime/mixin'
import { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
import { requireId } from '@struktoai/mirage-core/runtime/sandbox/config'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type { RunResult, SandboxPipe } from '@struktoai/mirage-core/runtime/types'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { SMOLVM_CONFIG_KEYS, type SmolvmConfig } from './config.ts'
import { RUNNING_STATE, SMOLVM_CLI_HINT, notRunningHint } from './constants.ts'
import { type CliResult, execArgs, openCliPipe, runCli } from '../cli.ts'

/**
 * A microVM the user runs as a whole-line runtime.
 *
 * You start the machine yourself; mirage only connects to it and
 * execs lines. The smolvm CLI is the transport, so there is no SDK
 * dependency and no daemon socket wiring; each line is one `smolvm
 * machine exec` with the merged environment, the session cwd, real
 * stdin, and separated stderr.
 *
 * Unlike a container, the guest runs its own kernel, so the line sees
 * that kernel's filesystem and nothing of the host's except what the
 * machine was given at boot (`--volume`). Serve the workspace inside
 * the guest at the host's mount prefixes, the same contract every
 * provider in this family carries.
 */
export class SmolvmRuntime
  extends RemoteSandbox<SmolvmConfig>
  implements ProcessExecutor<undefined>
{
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name = 'smolvm'

  constructor(options: RuntimeOptions<SmolvmConfig> = {}) {
    super(options, SMOLVM_CONFIG_KEYS)
    requireId('smolvm', 'machine', this.config.machine)
  }

  // One smolvm CLI invocation; the seam tests override.
  protected smolvm(
    args: string[],
    stdin: Uint8Array | null = null,
    signal?: AbortSignal,
  ): Promise<CliResult> {
    return runCli('smolvm', SMOLVM_CLI_HINT, args, stdin, signal !== undefined ? { signal } : {})
  }

  /**
   * Probe the machine, refusing any state that cannot take a line.
   *
   * `machine exec` would start a stopped machine on its own, but this
   * family never manages sandbox lifecycle, so a machine that is not
   * already running is an error rather than a boot.
   */
  async connect(): Promise<void> {
    const result = await this.smolvm(['machine', 'status', '--name', this.config.machine, '--json'])
    if (result.code !== 0) {
      throw new Error(`smolvm machine status failed: ${DECODER.decode(result.stderr).trim()}`)
    }
    let status: { state?: unknown }
    try {
      status = JSON.parse(DECODER.decode(result.stdout)) as { state?: unknown }
    } catch (error) {
      throw new Error(`smolvm machine status returned unreadable json: ${String(error)}`)
    }
    if (status.state !== RUNNING_STATE) {
      throw new Error(notRunningHint(this.config.machine, String(status.state)))
    }
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const result = await this.smolvm(execArgs(this.head(), ['--'], env, cwd, argv), stdin, signal)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }

  override async openPipe(command: string): Promise<SandboxPipe> {
    return openCliPipe('smolvm', execArgs(this.head(), ['--'], {}, null, ['sh', '-c', command]))
  }

  private head(): string[] {
    return ['machine', 'exec', '--name', this.config.machine, '-i']
  }
}

const DECODER = new TextDecoder()

registerRuntime('smolvm', SmolvmRuntime)
