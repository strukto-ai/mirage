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
import {
  RUNNING_STATE,
  MICROSANDBOX_CLI_HINT,
  INSPECT_TIMEOUT_SECONDS,
  notRunningHint,
} from './constants.ts'
import { type CliResult, execArgs, openCliPipe, runCli } from '../cli.ts'

/**
 * Run programs in an existing Microsandbox guest through the msb CLI.
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

  // One msb CLI invocation.
  protected microsandbox(
    args: string[],
    stdin: ByteSource | null = null,
    output: OutputFn | null = null,
    signal?: AbortSignal,
  ): Promise<CliResult> {
    return runCli('msb', MICROSANDBOX_CLI_HINT, args, stdin, {
      ...(signal !== undefined ? { signal } : {}),
      ...(output !== null ? { output } : {}),
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
    const args = ['status', this.config.sandbox, '--format', 'json']
    const result = await this.microsandbox(args, null, null, signal)
    if (result.code !== 0) {
      const detail = DECODER.decode(result.stderr).trim()
      throw new Error(`msb status failed: ${detail}`)
    }
    let status: unknown
    try {
      status = JSON.parse(DECODER.decode(result.stdout))
    } catch (error) {
      throw new Error(`msb status returned unreadable json: ${String(error)}`)
    }
    if (status === null || typeof status !== 'object' || Array.isArray(status)) {
      throw new Error('msb status returned an invalid status object')
    }
    const state = (status as { status?: unknown }).status
    if (state !== RUNNING_STATE) {
      throw new Error(notRunningHint(this.config.sandbox, String(state)))
    }
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    // Released msb can still auto-start a guest stopped after this probe.
    signal?.throwIfAborted()
    await this.connect(signal)
    signal?.throwIfAborted()
    const args = execArgs(this.head(), ['--'], env, cwd, argv)
    const result = await this.microsandbox(args, stdin, output, signal)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  }

  async openPipe(command: string): Promise<SandboxPipe> {
    await this.connect()
    return openCliPipe(
      'msb',
      execArgs([...this.head(), '--stream'], ['--'], {}, null, ['/bin/sh', '-c', command]),
    )
  }

  private head(): string[] {
    return ['exec', this.config.sandbox, '--quiet', '--no-tty']
  }
}

const DECODER = new TextDecoder()

registerRuntime('microsandbox', MicrosandboxRuntime)
