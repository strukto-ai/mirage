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

import { PathSpec } from '../../types.ts'
import { LanguageRuntime } from '../language.ts'
import type { Argv0Rules } from '../source.ts'
import type { RunResult, RuntimeLanguage } from '../types.ts'
import type { RuntimeOptions } from '../config.ts'
import { PAYLOAD_ARGV0, STDIN_ARGV0 } from './execution.ts'

/** CPython's own four answers, pinned on 3.12.13/3.13.7. */
export const CPYTHON_ARGV0: Argv0Rules = {
  payload: PAYLOAD_ARGV0,
  stdinOperand: STDIN_ARGV0,
  bareStdin: '',
  namesFile: true,
}

/**
 * The program that `-m mod` runs, on any engine that is real CPython.
 *
 * runpy does the work: run_module finds the module, runs it under
 * __main__, and alter_sys rewrites sys.argv[0] to the module's own
 * file, which is what CPython puts there. Engines that are not CPython
 * declare runsModules false and never see this.
 *
 * The existence probe is not redundant with run_module: CPython answers
 * a missing module with one line and exit 1, while bare run_module
 * raises, which would reach the user as a runpy traceback. Probing
 * first also keeps an ImportError raised INSIDE the module distinct
 * from the module itself being absent, which a try around run_module
 * could not tell apart.
 *
 * @param name the module to run.
 * @param label the command name used in the not-found message.
 */
export function moduleSource(name: string, label: string): string {
  return [
    'import importlib.util, runpy, sys',
    `_name = ${JSON.stringify(name)}`,
    `_label = ${JSON.stringify(label)}`,
    'try:',
    '    _found = importlib.util.find_spec(_name) is not None',
    // find_spec raises rather than returning None when an ancestor of a
    // dotted name is missing or is not a package; either way the module
    // cannot be found, and the message below reports it.
    'except (ImportError, TypeError, ValueError):',
    '    _found = False',
    'if not _found:',
    "    sys.stderr.write(_label + ': No module named ' + _name + chr(10))",
    '    raise SystemExit(1)',
    "runpy.run_module(_name, run_name='__main__', alter_sys=True)",
    '',
  ].join('\n')
}

/**
 * The python tier: every runtime that interprets Python source.
 *
 * Groups the engines behind the python3/python commands (pyodide,
 * monty here; wasi, local in Python and @struktoai/mirage-node), so
 * `language` and the default captures are declared once and
 * python-tier behavior has one home. A new Python engine subclasses
 * this, not LanguageRuntime.
 */
export abstract class PythonRuntime<E = unknown> extends LanguageRuntime<E> {
  readonly language: RuntimeLanguage = 'python'
  /** The tier's head words: the class-default captures of every python engine. */
  static override readonly commands: readonly string[] = ['python3', 'python'] as const
  override readonly argv0Rules: Argv0Rules = CPYTHON_ARGV0
  /**
   * Whether `python3 -m mod` can run at all. True for every engine that
   * is real CPython, since runpy does the work; false for an engine
   * implementing a subset of the language with no import system to find
   * a module with. A capability of the tier, declared here rather than
   * probed, so a refusal can name the runtime.
   */
  readonly runsModules: boolean = true
  protected readonly versionSuffix: string = ''

  override moduleCode(name: string, label: string): string | null {
    return this.runsModules ? moduleSource(name, label) : null
  }

  override async version(
    env: Record<string, string>,
    signal?: AbortSignal,
    timeoutSeconds?: number,
  ): Promise<RunResult> {
    // Process runtimes must supply a probe that cannot run startup hooks.
    if (this.reach !== 'workspace') return super.version(env, signal, timeoutSeconds)
    return this.interpret(
      await this.engine(),
      {
        code: `import sys\nprint('Python ' + sys.version.split()[0] + ${JSON.stringify(this.versionSuffix)})`,
        args: [],
        stdin: null,
      },
      {
        stdin: null,
        flags: {},
        cwd: PathSpec.fromStrPath('/'),
        env,
        ...(signal !== undefined ? { signal } : {}),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      },
    )
  }

  constructor(options: RuntimeOptions<object> = {}, configKeys: readonly string[] = []) {
    super(options, PythonRuntime.commands, configKeys)
  }
}
