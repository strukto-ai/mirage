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

import { IOResult } from '../../../io/types.ts'
import type { RunResult } from '../../../runtime/types.ts'

/**
 * Convert one interpreter outcome into a command's output pair.
 *
 * The single RunResult-to-IOResult mapping: empty stdout becomes null
 * (no stream), the exit code and stderr pass through. The interpreter
 * handlers and the CLI script arm both convert through here so the
 * mapping cannot drift (Python's run_output in
 * commands/builtin/general/interpreter.py).
 */
export function runOutput(result: RunResult): [Uint8Array | null, IOResult] {
  return [
    result.stdout.length > 0 ? result.stdout : null,
    new IOResult({ exitCode: result.exitCode, stderr: result.stderr }),
  ]
}

// Which of an interpreter's four doors the source came through. The
// mode is what decides argv[0], so the two travel together: CPython
// spells it '-c' for a payload, the module's file for -m, the file as
// typed for a script, '-' for the explicit stdin operand, and '' for
// stdin with no operand at all. Pinned on CPython 3.12.13.
export type SourceMode = 'payload' | 'module' | 'file' | 'stdin'

// argv[0] for the two modes that do not read it off the command line.
export const PAYLOAD_ARGV0 = '-c'
export const STDIN_ARGV0 = '-'
export const STDIN_OPERAND = '-'

/**
 * Drop a script's first line the way CPython's `-x` does.
 *
 * The first line is emptied rather than removed, because CPython keeps
 * the line numbering of the whole file: a raise on physical line 2
 * still reports line 2 under `-x` (pinned on 3.12.11). A file with no
 * newline at all is one line, so `-x` leaves nothing.
 *
 * Args:
 *   code: the script's text as read.
 */
export function skipFirstLine(code: string): string {
  const at = code.indexOf('\n')
  return at === -1 ? '' : code.slice(at)
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
 * Args:
 *   name: the module to run.
 *   label: the command name used in the not-found message.
 */
export function moduleSource(name: string, label: string): string {
  const mod = JSON.stringify(name)
  const lbl = JSON.stringify(label)
  return [
    'import importlib.util, runpy, sys',
    `_name = ${mod}`,
    `_label = ${lbl}`,
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
