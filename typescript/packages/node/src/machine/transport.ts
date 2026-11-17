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
import { MachineHandle, logger } from '@struktoai/mirage-core/machine/handle'
import { PIPE_TRANSPORT, type PipeTransport } from '@struktoai/mirage-core/machine/mixin'
import type { MachinePipe } from '@struktoai/mirage-core/machine/types'
import { answerOf } from '@struktoai/mirage-core/runtime/binding'
import type { OutputFn, RunAnswer, RunResult } from '@struktoai/mirage-core/runtime/types'
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
    stdin: ByteSource | null,
    output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return runProgram(this.program, this.installHint, args, stdin, {
      ...(signal !== undefined ? { signal } : {}),
      output,
      errors,
      connection: true,
    })
  }

  /**
   * Run the program once for Mirage's own question (a status, a pause), its
   * answer kept whole. Mirrors Python's `_program_answer`.
   *
   * @param args the arguments after the program.
   * @param signal stops the program.
   */
  protected programAnswer(args: string[], signal?: AbortSignal): Promise<RunAnswer> {
    return answerOf((output, errors) => this.execProgram(args, null, output, errors, signal))
  }

  /**
   * Pause or resume the machine through the program, failing loud unless its
   * stderr says the machine is already gone.
   *
   * @param args the arguments after the program.
   * @param gone what the program's stderr says of a machine already gone,
   *   which then counts as done; null fails on it too.
   * @param signal stops the program.
   */
  protected async changeState(
    args: string[],
    gone: string | null = null,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.programAnswer(args, signal)
    if (result.exitCode === 0) return
    const said = new TextDecoder().decode(result.stderr).trim()
    if (gone !== null && said.includes(gone)) {
      logger.debug?.(`${this.machine.toString()}: already gone: ${said}`)
      return
    }
    throw new Error(`${this.program} ${args.join(' ')} failed: ${said}`)
  }

  protected override execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const [head, tail] = this.execWords()
    return this.execProgram(execArgs(head, tail, env, cwd, argv), stdin, output, errors, signal)
  }

  openPipe(command: string): Promise<MachinePipe> {
    const [head, tail] = this.execWords()
    return openProgramPipe(this.program, execArgs(head, tail, {}, null, ['/bin/sh', '-c', command]))
  }
}
