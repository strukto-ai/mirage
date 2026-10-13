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

import type { ByteSource } from '../../../io/types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import type { LanguageRuntime } from '../../../runtime/language.ts'
import { QuickJsUnavailableError } from '../../../runtime/js/quickjs/errors.ts'
import { MontyUnavailableError } from '../../../runtime/python/monty/errors.ts'
import { PyodideUnavailableError } from '../../../runtime/python/pyodide/errors.ts'
import { PythonRuntime } from '../../../runtime/python/base.ts'
import { PAYLOAD_ARGV0, STDIN_ARGV0 } from '../../../runtime/python/execution.ts'
import type { RunResult } from '../../../runtime/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { isMissingPath } from '../../../errors/fs.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveScript } from '../utils/paths.ts'

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

/**
 * Whether a thrown error means the runtime itself is missing (exit 127),
 * not that the program it ran failed.
 *
 * Args:
 *   err: the error the runtime threw.
 */
export function runtimeUnavailable(err: unknown): err is Error {
  return (
    err instanceof QuickJsUnavailableError ||
    err instanceof MontyUnavailableError ||
    err instanceof PyodideUnavailableError
  )
}

export async function runtimeVersion(
  label: string,
  runtime: LanguageRuntime,
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutSeconds?: number,
): Promise<[Uint8Array | null, IOResult]> {
  try {
    return runOutput(await runtime.version(env, signal, timeoutSeconds))
  } catch (err) {
    if (err instanceof CommandTimeoutError) throw err
    const message = err instanceof Error ? err.message : String(err)
    return [
      null,
      new IOResult({
        exitCode: runtimeUnavailable(err) ? 127 : 1,
        stderr: new TextEncoder().encode(`${label}: ${message}\n`),
      }),
    ]
  }
}

// Which of an interpreter's four entry points the source came through. The
// mode is what decides argv[0], so the two travel together: CPython
// spells it '-c' for a payload, the module's file for -m, the file as
// typed for a script, '-' for the explicit stdin operand, and '' for
// stdin with no operand at all. Pinned on CPython 3.12.13.
export type SourceMode = 'payload' | 'module' | 'file' | 'stdin'

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

/**
 * What an interpreter calls itself in the entry points with no file name.
 *
 * File mode is universal (the operand as typed), so only these three
 * differ, and they differ per interpreter rather than per language:
 * CPython puts '-c' in argv[0] for a payload, while qjs leaves scriptArgs
 * alone for `-e` and fills it only when it runs a file. An interpreter
 * that names none of them leaves them undefined, and its runtime sees the
 * unnamed program. `namesFile` false is qjs, whose scriptArgs start at
 * the first argument even when it runs a file. Mirrors Python's
 * `Argv0Rules`.
 */
export interface Argv0Rules {
  payload?: string
  stdinOperand?: string
  bareStdin?: string
  namesFile?: boolean
}

/** CPython's own four answers, pinned on 3.12.13/3.13.7. */
export const CPYTHON_ARGV0: Argv0Rules = {
  payload: PAYLOAD_ARGV0,
  stdinOperand: STDIN_ARGV0,
  bareStdin: '',
  namesFile: true,
}

/**
 * An interpreter command's inputs, resolved from the command line.
 * `argv0` '' is meaningful (CPython's answer for stdin with no operand);
 * undefined means this interpreter names no program here. Mirrors
 * Python's `Source`.
 */
export interface Source {
  code: string
  args: string[]
  stdin: Uint8Array | null
  scriptPath: PathSpec | null
  mode: SourceMode
  argv0?: string
}

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function failed(label: string, message: string, exitCode: number): CommandFnResult {
  return [null, new IOResult({ exitCode, stderr: ENC.encode(`${label}: ${message}\n`) })]
}

/**
 * The answer of an interpreter command no runtime runs: bash's
 * `command not found`, exit 127, whatever the operands say.
 */
export function notBound(label: string): CommandFnResult {
  return failed(label, 'command not found', 127)
}

function readAllBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return Promise.resolve(data)
  if (data === null || data === undefined) return Promise.resolve(new Uint8Array())
  return materialize(data as ByteSource)
}

function toPathSpec(p: PathSpec): PathSpec {
  return new PathSpec({
    virtual: p.virtual,
    directory: p.directory,
    pattern: p.pattern,
    resolved: p.resolved,
    vfsPath: mountKey(p.virtual, mountPrefixOf(p.virtual, p.vfsPath)),
  })
}

/**
 * Resolve what an interpreter command should run, shared by all.
 *
 * A payload flag wins (-c/-e), else the first operand is the script
 * (read through the workspace dispatch), else piped stdin is the source.
 * Words after the script pass through verbatim as argv. The x check
 * follows the source's entry point: a file operand asks the per-path
 * entry point about the script's own path, so a session whose only x
 * grant is one show subtree runs scripts there and nowhere else; inline
 * code, -m and stdin keep the whole-session rule, since no path holds
 * them. Outside a workspace no entry point is wired and `execAllowed`
 * answers for files too. Mirrors Python's `resolve_source`.
 *
 * Args:
 *   label: the command name used in error messages.
 *   paths: positional path operands.
 *   texts: positional text operands.
 *   payload: the -c/-e flag value, if given.
 *   opts: the command's options (stdin, dispatch, cwd, the x checks).
 *   module: the -m module name, if given.
 *   argv0Rules: what this interpreter calls itself where no file names it.
 *   skipLine: drop the script file's first line (CPython's -x).
 *
 * Returns:
 *   an early error output, or the prepared source.
 */
export async function resolveSource(
  label: string,
  paths: PathSpec[],
  texts: string[],
  payload: string | null,
  opts: CommandOpts,
  module: string | null = null,
  argv0Rules: Argv0Rules = {},
  skipLine = false,
): Promise<CommandFnResult | Source> {
  let code = payload
  let scriptPath: PathSpec | null = null
  let mode: SourceMode = 'payload'
  let argv0 = argv0Rules.payload
  let args: string[]
  if (module !== null) {
    // runpy's alter_sys overwrites argv[0] with the module's own file,
    // which no caller can know here; the module name stands in for the
    // runtimes that never reach runpy.
    code = moduleSource(module, label)
    args = [...paths.map((p) => p.virtual), ...texts]
    mode = 'module'
    argv0 = module
  } else if (code !== null) {
    args = [...paths.map((p) => p.virtual), ...texts]
  } else if (paths.length > 0) {
    scriptPath = paths[0] ?? null
    args = [...paths.slice(1).map((p) => p.virtual), ...texts]
    mode = 'file'
    argv0 = argv0Rules.namesFile === true ? (paths[0]?.rawPath ?? '') : undefined
  } else if (texts[0] === STDIN_OPERAND) {
    // The explicit stdin spelling. It is an operand, not a flag, so the
    // words after it are the program's argv exactly as a script's would
    // be.
    args = texts.slice(1)
    mode = 'stdin'
    argv0 = argv0Rules.stdinOperand
  } else if (texts.length > 0) {
    scriptPath = resolveScript(texts[0] ?? '', opts.cwd)
    args = texts.slice(1)
    mode = 'file'
    // As typed, which is what CPython puts in argv[0]; the resolved
    // spelling is scriptPath's job.
    argv0 = argv0Rules.namesFile === true ? (texts[0] ?? '') : undefined
  } else {
    args = []
    mode = 'stdin'
    argv0 = argv0Rules.bareStdin
  }

  if (mode === 'file' && scriptPath !== null) {
    const allowed = opts.execPathAllowed?.(scriptPath.virtual) ?? opts.execAllowed !== false
    if (!allowed) {
      const display = scriptPath.rawPath !== '' ? scriptPath.rawPath : scriptPath.virtual
      return failed(label, `${display}: not in EXEC mode`, 126)
    }
  } else if (opts.execAllowed === false) {
    return failed(label, "root mount '/' is not in EXEC mode", 126)
  }

  if (code === null && scriptPath !== null) {
    if (opts.dispatch === undefined) return failed(label, 'no dispatch available to read script', 1)
    let data: unknown
    try {
      data = (await opts.dispatch('read', toPathSpec(scriptPath)))[0]
    } catch (err) {
      if (!isMissingPath(err)) throw err
      return failed(label, `${scriptPath.virtual}: No such file`, 1)
    }
    code = DEC.decode(await readAllBytes(data))
    if (skipLine) code = skipFirstLine(code)
  }

  let stdin = opts.stdin !== null ? await materialize(opts.stdin) : null
  if (code === null) {
    if (stdin === null || stdin.length === 0) return failed(label, 'no input', 1)
    code = DEC.decode(stdin)
    stdin = null
  }
  return { code, args, stdin, scriptPath, mode, ...(argv0 !== undefined ? { argv0 } : {}) }
}

/**
 * Run a prepared source on the bound runtime, shared by all. Mirrors
 * Python's `run_code`.
 *
 * Args:
 *   label: the command name used in error messages.
 *   prepared: the resolved source and argv.
 *   runtime: the runtime bound to this command.
 *   switches: interpreter-level switches (Python's InitFlags, js's
 *     `module`), handed to the runtime as its run flags.
 *   opts: the command's options (env, cwd, signal, limit).
 */
export async function runCode(
  label: string,
  prepared: Source,
  runtime: LanguageRuntime,
  switches: Record<string, unknown>,
  opts: CommandOpts,
): Promise<CommandFnResult> {
  if (prepared.mode === 'module' && runtime instanceof PythonRuntime && !runtime.runsModules) {
    // Exit 1, CPython's code for a `-m` that could not run, but not its
    // "No module named" wording: nothing was searched for, so naming the
    // runtime is the honest report.
    return failed(label, `-m is not supported by the '${runtime.name}' runtime`, 1)
  }
  try {
    const result = await runtime.execute({
      kind: 'code',
      language: runtime.language,
      code: prepared.code,
      args: prepared.args,
      env: opts.env ?? {},
      cwd: PathSpec.fromStrPath(opts.cwd),
      ...(prepared.scriptPath !== null ? { scriptPath: prepared.scriptPath } : {}),
      stdin: prepared.stdin,
      ...(prepared.argv0 !== undefined ? { prog: prepared.argv0 } : {}),
      flags: switches,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
    })
    return runOutput(result)
  } catch (err) {
    // An in-VM limit interrupt is a timeout, not an interpreter
    // failure: let it reach the workspace's 124 handler.
    if (err instanceof CommandTimeoutError) throw err
    const message = err instanceof Error ? err.message : String(err)
    return failed(label, message, runtimeUnavailable(err) ? 127 : 1)
  }
}
