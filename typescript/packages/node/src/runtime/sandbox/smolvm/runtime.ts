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

import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { RemoteSandbox } from '@struktoai/mirage-core/runtime/sandbox/base'
import { PIPE_TRANSPORT, type PipeTransport } from '@struktoai/mirage-core/runtime/sandbox/mixin'
import { requireId } from '@struktoai/mirage-core/runtime/sandbox/config'
import { registerRuntime } from '@struktoai/mirage-core/runtime/table'
import type { OutputFn, RunResult, SandboxPipe } from '@struktoai/mirage-core/runtime/types'
import type { RuntimeOptions } from '@struktoai/mirage-core/runtime/config'
import { SMOLVM_CONFIG_KEYS, type SmolvmConfig } from './config.ts'
import { notRunningHint } from '@struktoai/mirage-core/runtime/sandbox/constants'
import { RUNNING_STATE, SMOLVM_HINT, STATE_HINTS } from './constants.ts'
import { execArgs, openProgramPipe, reportedState, runProgram } from '../program.ts'

/**
 * A microVM the user runs as a whole-line runtime.
 *
 * You start the machine yourself; mirage only connects to it and
 * execs lines. The `smolvm` program is the transport, so there is no SDK
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
export class SmolvmRuntime extends RemoteSandbox<SmolvmConfig> implements PipeTransport {
  readonly [PIPE_TRANSPORT] = true as const
  readonly name = 'smolvm'

  constructor(options: RuntimeOptions<SmolvmConfig> = {}) {
    super(options, SMOLVM_CONFIG_KEYS)
    requireId('smolvm', 'machine', this.config.machine)
  }

  // Run `smolvm` once; the seam tests override.
  protected smolvm(
    args: string[],
    stdin: ByteSource | null = null,
    output: OutputFn | null = null,
    signal?: AbortSignal,
    errors: OutputFn | null = null,
  ): Promise<RunResult> {
    return runProgram('smolvm', SMOLVM_HINT, args, stdin, {
      ...(signal !== undefined ? { signal } : {}),
      ...(output !== null ? { output } : {}),
      ...(errors !== null ? { errors } : {}),
    })
  }

  /**
   * Probe the machine, refusing any state that cannot take a line.
   *
   * `machine exec` would start a stopped machine on its own, but this
   * family never manages sandbox lifecycle, so a machine that is not
   * already running is an error rather than a boot.
   */
  async connect(): Promise<void> {
    const machine = this.config.machine
    const status = await this.smolvm(['machine', 'status', '--name', machine, '--json'])
    const state = reportedState(status, 'smolvm machine status', ['state'])
    if (state !== RUNNING_STATE)
      throw new Error(notRunningHint('machine', machine, state, STATE_HINTS))
  }

  protected override execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return this.smolvm(execArgs(this.head(), ['--'], env, cwd, argv), stdin, output, signal, errors)
  }

  async openPipe(command: string): Promise<SandboxPipe> {
    return openProgramPipe(
      'smolvm',
      execArgs(this.head(), ['--'], {}, null, ['/bin/sh', '-c', command]),
    )
  }

  private head(): string[] {
    return ['machine', 'exec', '--name', this.config.machine, '-i']
  }
}

registerRuntime('smolvm', SmolvmRuntime)
