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
import { MICROSANDBOX_CONFIG_KEYS, type MicrosandboxConfig } from './config.ts'
import { notRunningHint } from '@struktoai/mirage-core/runtime/sandbox/constants'
import { RUNNING_STATE, MICROSANDBOX_HINT, INSPECT_TIMEOUT_SECONDS } from './constants.ts'
import { execArgs, openProgramPipe, reportedState, runProgram } from '../program.ts'

/**
 * Run programs in an existing Microsandbox guest through `msb`.
 * The user starts the sandbox and serves its workspace at the same paths
 * inside the guest. Mirage forwards commands, stdin, environment, and cwd
 * without managing the sandbox's lifecycle.
 */
export class MicrosandboxRuntime
  extends RemoteSandbox<MicrosandboxConfig>
  implements PipeTransport
{
  readonly [PIPE_TRANSPORT] = true as const
  readonly name = 'microsandbox'

  constructor(options: RuntimeOptions<MicrosandboxConfig> | Record<string, unknown> = {}) {
    super(options, MICROSANDBOX_CONFIG_KEYS)
    requireId('microsandbox', 'sandbox', this.config.sandbox)
  }

  /** Skip the connect-once latch: every exec probes the guest. */
  protected override ensureConnected(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return Promise.resolve()
  }

  // Run `msb` once.
  protected microsandbox(
    args: string[],
    stdin: ByteSource | null = null,
    output: OutputFn | null = null,
    signal?: AbortSignal,
    errors: OutputFn | null = null,
  ): Promise<RunResult> {
    return runProgram('msb', MICROSANDBOX_HINT, args, stdin, {
      ...(signal !== undefined ? { signal } : {}),
      ...(output !== null ? { output } : {}),
      ...(errors !== null ? { errors } : {}),
    })
  }

  /** Require a running sandbox before executing any commands. */
  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const deadline = AbortSignal.timeout(INSPECT_TIMEOUT_SECONDS * 1000)
    const probeSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    try {
      await this.inspect(probeSignal)
    } catch (error) {
      signal?.throwIfAborted()
      if (deadline.aborted)
        throw new Error(
          `msb runtime inspection timed out after ${String(INSPECT_TIMEOUT_SECONDS)} seconds`,
          { cause: error },
        )
      throw error
    }
  }

  private async inspect(signal: AbortSignal): Promise<void> {
    const sandbox = this.config.sandbox
    const status = await this.microsandbox(
      ['status', sandbox, '--format', 'json'],
      null,
      null,
      signal,
    )
    const state = reportedState(status, 'msb status', ['status'])
    if (state !== RUNNING_STATE)
      throw new Error(notRunningHint('sandbox', sandbox, state, {}, 'start it with msb start'))
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
    // Released msb can still auto-start a guest stopped after this probe.
    signal?.throwIfAborted()
    await this.connect(signal)
    signal?.throwIfAborted()
    const args = execArgs(this.head(), ['--'], env, cwd, argv)
    return this.microsandbox(args, stdin, output, signal, errors)
  }

  async openPipe(command: string): Promise<SandboxPipe> {
    await this.connect()
    return openProgramPipe(
      'msb',
      execArgs([...this.head(), '--stream'], ['--'], {}, null, ['/bin/sh', '-c', command]),
    )
  }

  private head(): string[] {
    return ['exec', this.config.sandbox, '--quiet']
  }
}

registerRuntime('microsandbox', MicrosandboxRuntime)
