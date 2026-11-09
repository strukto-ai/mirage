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
import { requireId } from '@struktoai/mirage-core/machine/config'
import { registerMachine } from '@struktoai/mirage-core/machine/registry'
import type { MachinePipe } from '@struktoai/mirage-core/machine/types'
import type { OutputFn, RunResult } from '@struktoai/mirage-core/runtime/types'
import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import { MICROSANDBOX_CONFIG_FIELDS, type MicrosandboxConfig } from './config.ts'
import { EXEC_PRELUDE, notRunningHint } from '@struktoai/mirage-core/machine/constants'
import {
  RUNNING_STATE,
  MICROSANDBOX_HINT,
  INSPECT_TIMEOUT_SECONDS,
  ownSession,
} from './constants.ts'
import { execArgs, openProgramPipe, reportedState } from '../program.ts'
import { ProgramMachine } from '../transport.ts'

/**
 * Run programs in an existing Microsandbox guest through `msb`.
 * The user starts the machine and serves its workspace at the same paths
 * inside the guest. Mirage forwards commands, stdin, environment, and cwd
 * without managing the machine's lifecycle.
 */
export class MicrosandboxMachine extends ProgramMachine<MicrosandboxConfig> {
  static override readonly configFields: ConfigFields = MICROSANDBOX_CONFIG_FIELDS
  static override readonly provider = 'microsandbox'
  protected readonly program = 'msb'
  protected readonly installHint = MICROSANDBOX_HINT

  constructor(name: string, config?: MicrosandboxConfig) {
    super(name, config, MicrosandboxMachine.configFields)
    requireId('microsandbox', 'sandbox', this.config.sandbox)
  }

  /** Skip the connect-once latch: every exec probes the guest. */
  protected override ensureConnected(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return Promise.resolve()
  }

  protected execWords(): readonly [readonly string[], readonly string[]] {
    return [['exec', this.config.sandbox, '--quiet'], ['--']]
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
        throw new Error(`msb status timed out after ${String(INSPECT_TIMEOUT_SECONDS)} seconds`, {
          cause: error,
        })
      throw error
    }
  }

  private async inspect(signal: AbortSignal): Promise<void> {
    const sandbox = this.config.sandbox
    const status = await this.execProgram(
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
    // Piped stdin skips --stream: msb fails more runs that close it early.
    const [words, tail] = this.execWords()
    const head = stdin === null ? [...words, '--stream'] : words
    return this.execProgram(
      execArgs(head, tail, env, null, [
        '/bin/sh',
        '-c',
        EXEC_PRELUDE,
        'sh',
        cwd,
        ...ownSession(argv),
      ]),
      stdin,
      output,
      signal,
      errors,
    )
  }

  override async openPipe(command: string): Promise<MachinePipe> {
    await this.connect()
    const [head, tail] = this.execWords()
    return openProgramPipe(
      this.program,
      execArgs([...head, '--stream'], tail, {}, null, ['/bin/sh', '-c', command]),
    )
  }
}

registerMachine('microsandbox', MicrosandboxMachine)
