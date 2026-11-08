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
import { MachineHandle } from '@struktoai/mirage-core/machine/handle'
import { PIPE_TRANSPORT, type PipeTransport } from '@struktoai/mirage-core/machine/mixin'
import { registerMachine } from '@struktoai/mirage-core/machine/registry'
import type { OutputFn, RunResult, SandboxPipe } from '@struktoai/mirage-core/runtime/types'
import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import { requireId } from '@struktoai/mirage-core/machine/config'
import { APPLE_CONTAINER_CONFIG_FIELDS, type AppleContainerConfig } from './config.ts'
import { APPLE_CONTAINER_HINT, RUNNING_STATE, STATE_HINTS } from './constants.ts'
import { notRunningHint } from '@struktoai/mirage-core/machine/constants'
import { execArgs, openProgramPipe, reportedState, runProgram } from '../program.ts'

/**
 * A container under Apple's `container` tool.
 *
 * You start the container yourself; mirage only connects to it and
 * execs lines. The `container` program is the transport, so there is no
 * SDK dependency and no XPC wiring; each line is one `container exec`
 * with the merged environment, the session cwd, real stdin, and
 * separated stderr.
 *
 * Each container is its own lightweight VM with its own Linux kernel,
 * so, as in a smolvm guest, the line sees nothing of the host's
 * filesystem except what the container was given at start
 * (`--volume`). Serve the workspace inside it at the host's mount
 * prefixes, the same contract every provider in this family carries.
 * The image needs a POSIX /bin/sh, which every argv runs under (EXEC_PRELUDE).
 *
 * One machine is one container, so an agent gets a VM of its own as a
 * machine of its own, which a policy route sends its session to.
 */
export class AppleContainerMachine
  extends MachineHandle<AppleContainerConfig>
  implements PipeTransport
{
  static override readonly configFields: ConfigFields = APPLE_CONTAINER_CONFIG_FIELDS
  readonly [PIPE_TRANSPORT] = true as const
  static override readonly provider = 'apple_container'

  constructor(name: string, config?: AppleContainerConfig) {
    super(name, config, AppleContainerMachine.configFields)
    requireId('apple_container', 'container', this.config.container)
  }

  /** Run `container` once; the seam tests override. */
  protected container(
    args: string[],
    stdin: ByteSource | null = null,
    output: OutputFn | null = null,
    signal?: AbortSignal,
    errors: OutputFn | null = null,
  ): Promise<RunResult> {
    return runProgram('container', APPLE_CONTAINER_HINT, args, stdin, {
      ...(signal !== undefined ? { signal } : {}),
      ...(output !== null ? { output } : {}),
      ...(errors !== null ? { errors } : {}),
    })
  }

  /**
   * Refuse a container in any state that cannot take a line.
   *
   * `container exec` refuses a container that is not running as well;
   * probing up front names the state and how to recover.
   */
  async connect(): Promise<void> {
    const container = this.config.container
    const status = await this.container(['inspect', container])
    const state = reportedState(status, 'container inspect', [0, 'status', 'state'])
    if (state !== RUNNING_STATE)
      throw new Error(notRunningHint('container', container, state, STATE_HINTS))
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const args = execArgs(['exec', '-i'], [this.config.container], env, cwd, argv)
    return this.container(args, stdin, output, signal, errors)
  }

  openPipe(command: string): Promise<SandboxPipe> {
    return openProgramPipe(
      'container',
      execArgs(['exec', '-i'], [this.config.container], {}, null, ['/bin/sh', '-c', command]),
    )
  }
}

registerMachine('apple_container', AppleContainerMachine)
