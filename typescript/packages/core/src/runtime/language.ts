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

import type { Context } from '../commands/config.ts'
import type { PathSpec } from '../types.ts'
import { Runtime } from './base.ts'
import { type Argv0Rules, resolveProgram } from './source.ts'
import type { Program, RunResult, Language } from './types.ts'

/**
 * A runtime that interprets one language's code inside a command.
 *
 * The engine inside a single command (python3, node): the workspace
 * splits the line, and a captured stage's operands land here as run().
 * Never the whole line; that is LineExecutor's entry point.
 *
 * The language it interprets is declared once, on its language tier
 * (PythonRuntime, JsRuntime), and a script CLI finds its interpreter by
 * it (runtimeForLanguage).
 *
 * run() resolves the program from the operands the way a real
 * interpreter does (`-c` in `ctx.flags`, else the script operand read
 * through `ctx.vfs`, else piped stdin) and hands it to interpret(). A
 * guest sees `ctx.env`, a copy whose writes do not mutate the Mirage
 * session; an adapter that means to write the session uses `ctx.session`.
 */
export abstract class LanguageRuntime<E = unknown> extends Runtime<E> {
  /**
   * The head words of this language's interpreter commands, the first
   * naming a program run with no command of its own.
   */
  static readonly commands: readonly string[] = []
  abstract readonly language: Language
  /** What this interpreter calls itself where no file names the program. */
  readonly argv0Rules: Argv0Rules = {}

  /**
   * Resolve the program from the operands, then interpret it.
   *
   * @param engine the install's engine.
   * @param paths the script operand, if any.
   * @param texts the program's argv.
   * @param ctx the run's context.
   */
  override async run(
    engine: E,
    paths: PathSpec[],
    texts: string[],
    ctx: Context,
  ): Promise<RunResult> {
    const named = ctx.spec?.name ?? ''
    const label =
      named !== '' ? named : ((this.constructor as typeof LanguageRuntime).commands[0] ?? this.name)
    const program = await resolveProgram(
      paths,
      texts,
      ctx,
      label,
      this.argv0Rules,
      (name, shown) => this.moduleCode(name, shown),
      this.name,
    )
    if ('exitCode' in program) return program
    return this.interpret(engine, program, ctx)
  }

  /**
   * The program `-m name` runs; null where this runtime cannot run a
   * module.
   *
   * @param _name the module.
   * @param _label the command name a not-found message uses.
   */
  moduleCode(_name: string, _label: string): string | null {
    return null
  }

  /** Report the bound interpreter's version. */
  version(
    _env: Record<string, string>,
    _signal?: AbortSignal,
    _timeoutSeconds?: number,
  ): Promise<RunResult> {
    return Promise.resolve({
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(`${this.name}: version information unavailable\n`),
      exitCode: 1,
    })
  }

  /**
   * Execute one program and return its captured outcome.
   *
   * Each call represents an independent language command, such as
   * python3 or node. Guest globals, imports and builtin mutations
   * do not carry over from earlier commands or evaluator sessions.
   * The adapter owns engine reuse; this does not reset workspace
   * state or undo external effects.
   *
   * @param engine the install's engine.
   * @param program the source and argv to run.
   * @param ctx the run's context: working directory, environment,
   *   switches, files, signal and limit.
   */
  abstract interpret(engine: E, program: Program, ctx: Context): Promise<RunResult>
}
