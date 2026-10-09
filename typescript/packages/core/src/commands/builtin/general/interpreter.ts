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
import type { DispatchFn, RunResult } from '../../../runtime/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { ExecutionNode } from '../../../workspace/types.ts'
import { isMissingPath } from '../../../errors/fs.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'

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
    const unavailable =
      err instanceof QuickJsUnavailableError ||
      err instanceof MontyUnavailableError ||
      err instanceof PyodideUnavailableError
    const message = err instanceof Error ? err.message : String(err)
    return [
      null,
      new IOResult({
        exitCode: unavailable ? 127 : 1,
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

type Result = [ByteSource | null, IOResult, ExecutionNode]

const ENC = new TextEncoder()

interface InterpreterDeps {
  runtime: LanguageRuntime
}

interface InterpreterOpts {
  command?: string
  stdin: ByteSource | null
  env: Record<string, string>
  cwd?: PathSpec
  code: string | null
  // argv[0], derived from which entry point the source came through; '' is
  // CPython's own answer for a program piped in with no operand, so a
  // runtime must not treat it as absent.
  prog?: string
  // Runtime-specific run flags (Python's InitFlags, js's `module`).
  flags?: Record<string, unknown>
  // Applied to a script read from a file (CPython's -x).
  transformSource?: (code: string) => string
  // A refusal decided once the runtime is bound (Python's -m guard):
  // the diagnostic text, or null to proceed.
  refuse?: (runtime: LanguageRuntime) => string | null
  signal?: AbortSignal
  timeoutSeconds?: number
}

// The language-specific half of an interpreter handler: everything else
// (reading the script, materializing stdin, running, mapping errors) is
// identical between python3 and js, mirroring Python's single run_code.
export interface InterpreterSpec {
  // Command name used in every diagnostic.
  label: string
  // Payload flag shown when no script operand was given (-c, -e).
  payloadFlag: string
  // Whether a thrown error means the runtime itself is missing (exit 127).
  isUnavailable: (err: unknown) => boolean
}

export type InterpreterHandler = (
  dispatch: DispatchFn,
  pathScope: PathSpec | null,
  args: string[],
  opts: InterpreterOpts,
  deps: InterpreterDeps,
) => Promise<Result>

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

// An interpreter diagnostic. The stderr rides the IOResult only: the node
// carries the command string and the code, matching what the shell prints.
function errorResult(cmdStr: string, message: string, exitCode: number): Result {
  return [
    null,
    new IOResult({ exitCode, stderr: ENC.encode(message) }),
    new ExecutionNode({ command: cmdStr, exitCode }),
  ]
}

/**
 * Build an interpreter command handler.
 *
 * @param spec - the label, payload flag and unavailable-error test that
 *   distinguish one interpreter from another.
 */
export function makeInterpreterHandler(spec: InterpreterSpec): InterpreterHandler {
  return async function handle(
    dispatch: DispatchFn,
    pathScope: PathSpec | null,
    args: string[],
    opts: InterpreterOpts,
    deps: InterpreterDeps,
  ): Promise<Result> {
    const label = opts.command ?? spec.label
    let code = opts.code
    // The file the program is read from, which the runtime names it after.
    const scriptPath = code === null ? pathScope : null
    const cmdStr =
      pathScope !== null ? `${label} ${pathScope.virtual}` : `${label} ${spec.payloadFlag}`

    if (code === null) {
      if (pathScope === null) return errorResult(cmdStr, `${label}: no input\n`, 1)
      let data: unknown
      try {
        data = (await dispatch('read', toPathSpec(pathScope)))[0]
      } catch (err) {
        if (!isMissingPath(err)) throw err
        return errorResult(cmdStr, `${label}: ${pathScope.virtual}: No such file\n`, 1)
      }
      const bytes = await readAllBytes(data)
      code = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      if (opts.transformSource !== undefined) code = opts.transformSource(code)
    }

    let stdinBytes: Uint8Array | null = null
    if (opts.stdin !== null) {
      stdinBytes = await materialize(opts.stdin)
    }

    try {
      const refusal = opts.refuse?.(deps.runtime) ?? null
      if (refusal !== null) return errorResult(cmdStr, refusal, 1)
      const result = await deps.runtime.execute({
        kind: 'code',
        language: deps.runtime.language,
        code,
        args,
        env: opts.env,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(scriptPath !== null ? { scriptPath } : {}),
        stdin: stdinBytes,
        ...(opts.prog !== undefined ? { prog: opts.prog } : {}),
        ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
      })
      const [stdout, io] = runOutput(result)
      return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: result.exitCode })]
    } catch (err) {
      // An in-VM limit interrupt is a timeout, not an interpreter
      // failure: let it reach the workspace's 124 handler.
      if (err instanceof CommandTimeoutError) throw err
      if (spec.isUnavailable(err)) {
        return errorResult(cmdStr, `${label}: ${(err as Error).message}\n`, 127)
      }
      const msg = err instanceof Error ? err.message : String(err)
      return errorResult(cmdStr, `${label}: ${msg}\n`, 1)
    }
  }
}
