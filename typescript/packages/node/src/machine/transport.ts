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
import type { MachineConfig } from '@struktoai/mirage-core/machine/config'
import { MachineHandle } from '@struktoai/mirage-core/machine/handle'
import { PIPE_TRANSPORT, type PipeTransport } from '@struktoai/mirage-core/machine/mixin'
import type { MachinePipe } from '@struktoai/mirage-core/machine/types'
import type { OutputFn, RunResult } from '@struktoai/mirage-core/runtime/types'
import { execArgs, openProgramPipe, runProgram } from './program.ts'

/**
 * A machine reached through a program on this host: each run is one exec of
 * it with the merged environment, the session cwd, real stdin and separated
 * stderr, so there is no SDK to load and no daemon socket to wire.
 */
export abstract class ProgramMachine<C extends MachineConfig = MachineConfig>
  extends MachineHandle<C>
  implements PipeTransport
{
  readonly [PIPE_TRANSPORT] = true as const
  protected abstract readonly program: string
  protected abstract readonly installHint: string

  /** The program's words before each `-e` variable and after them, the second the target or `--`. */
  protected abstract execWords(): readonly [readonly string[], readonly string[]]

  /** Run the program once; the seam tests override. */
  protected execProgram(
    args: string[],
    stdin: ByteSource | null = null,
    output: OutputFn | null = null,
    signal?: AbortSignal,
    errors: OutputFn | null = null,
  ): Promise<RunResult> {
    return runProgram(this.program, this.installHint, args, stdin, {
      ...(signal !== undefined ? { signal } : {}),
      ...(output !== null ? { output } : {}),
      ...(errors !== null ? { errors } : {}),
    })
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
    const [head, tail] = this.execWords()
    return this.execProgram(execArgs(head, tail, env, cwd, argv), stdin, output, signal, errors)
  }

  openPipe(command: string): Promise<MachinePipe> {
    const [head, tail] = this.execWords()
    return openProgramPipe(this.program, execArgs(head, tail, {}, null, ['/bin/sh', '-c', command]))
  }
}
