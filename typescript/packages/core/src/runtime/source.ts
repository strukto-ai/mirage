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
import type { FlagValue } from '../commands/spec/types.ts'
import { isMissingPath } from '../errors/fs.ts'
import { type ByteSource, materialize } from '../io/types.ts'
import { PathSpec } from '../types.ts'
import { mountKey, mountPrefixOf } from '../utils/key_prefix.ts'
import type { Program, RunResult } from './types.ts'

export const STDIN_OPERAND = '-'

/**
 * What an interpreter calls itself in the entry points with no file name.
 *
 * They differ per interpreter, not per language: CPython puts '-c' in
 * argv[0] for a payload, while qjs leaves scriptArgs alone for `-e`.
 */
export interface Argv0Rules {
  /** argv[0] for a -c/-e payload. */
  readonly payload?: string
  /** argv[0] for an explicit "-" operand. */
  readonly stdinOperand?: string
  /** argv[0] for a program piped in with no operand at all. */
  readonly bareStdin?: string
  /** File mode puts the operand in argv[0]; false for qjs. */
  readonly namesFile?: boolean
}

/**
 * Drop a script's first line the way CPython's `-x` does.
 *
 * The first line is emptied rather than removed, because CPython keeps
 * the line numbering of the whole file: a raise on physical line 2
 * still reports line 2 under `-x` (pinned on 3.12.11). A file with no
 * newline at all is one line, so `-x` leaves nothing.
 *
 * @param code the script's text as read.
 */
export function skipFirstLine(code: string): string {
  const at = code.indexOf('\n')
  return at === -1 ? '' : code.slice(at)
}

/**
 * The script an interpreter's operands name, null when the program comes
 * from `-c`, `-m` or stdin. The exec check and the runtime both ask it.
 *
 * @param paths the path operands.
 * @param texts the text operands.
 * @param flags the interpreter switches.
 * @param cwd the working directory a text operand resolves against.
 */
export function scriptOperand(
  paths: readonly PathSpec[],
  texts: readonly string[],
  flags: Readonly<Record<string, FlagValue>>,
  cwd: PathSpec | string | null,
): PathSpec | null {
  if (typeof flags.m === 'string' || typeof flags.c === 'string') return null
  const [first] = paths
  if (first !== undefined) return first
  const [word] = texts
  if (word !== undefined && word !== STDIN_OPERAND) {
    const base = cwd === null ? '/' : typeof cwd === 'string' ? cwd : cwd.virtual
    return PathSpec.fromStrPath(word, undefined, base === '' ? '/' : base)
  }
  return null
}

/**
 * An interpreter that ran nothing: its message and exit 1.
 *
 * @param message what it says on stderr, newline included.
 */
function failed(message: string): RunResult {
  return { stdout: new Uint8Array(), stderr: new TextEncoder().encode(message), exitCode: 1 }
}

/**
 * Resolve what a language runtime runs from its operands, as a real
 * interpreter does.
 *
 * `-c` wins, else `-m` names a module, else the first operand is the
 * script (read through `ctx.vfs`), else piped stdin is the program. A
 * script CLI names itself `ctx.spec.name`.
 *
 * @param paths the path operands.
 * @param texts the text operands.
 * @param ctx the run's context; `flags` holds the switches (`c`, `m`,
 *   `x`, `scriptCli`).
 * @param label the command name the messages use.
 * @param rules what this interpreter calls itself in the entry points
 *   that carry no file name.
 * @param moduleCode the program a `-m` runs, given the module and the
 *   label; null when this runtime cannot run a module.
 * @param runtimeName the runtime's name, for the `-m` refusal.
 * @returns the program, or why nothing ran.
 */
export async function resolveProgram(
  paths: readonly PathSpec[],
  texts: readonly string[],
  ctx: Context,
  label: string,
  rules: Argv0Rules,
  moduleCode: (name: string, label: string) => string | null,
  runtimeName: string,
): Promise<Program | RunResult> {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const flags = ctx.flags
  const payload = flags.c
  const module = flags.m
  let code = typeof payload === 'string' ? payload : null
  let script: PathSpec | null = null
  let argv0 = rules.payload
  let args: string[]
  if (typeof module === 'string') {
    // runpy's alter_sys overwrites argv[0] with the module's own file,
    // which no caller can know here; the module name stands in for the
    // runtimes that never reach runpy.
    code = moduleCode(module, label)
    if (code === null) {
      // Exit 1, CPython's code for a `-m` that could not run, but not its
      // "No module named" wording: nothing was searched for, so naming the
      // runtime is the honest report.
      return failed(`${label}: -m is not supported by the '${runtimeName}' runtime\n`)
    }
    args = [...paths.map((p) => p.virtual), ...texts]
    argv0 = module
  } else if (code !== null) {
    args = [...paths.map((p) => p.virtual), ...texts]
  } else if (paths[0] !== undefined) {
    script = paths[0]
    args = [...paths.slice(1).map((p) => p.virtual), ...texts]
    argv0 = rules.namesFile === true ? paths[0].rawPath : undefined
  } else if (texts[0] === STDIN_OPERAND) {
    // The explicit stdin spelling. It is an operand, not a flag, so it
    // ends option parsing like any other, and the words after it are the
    // program's argv exactly as a script's would be.
    args = texts.slice(1)
    argv0 = rules.stdinOperand
  } else if (texts[0] !== undefined) {
    script = scriptOperand(paths, texts, flags, ctx.cwd)
    args = texts.slice(1)
    // As typed, which is what CPython puts in argv[0]; the resolved
    // spelling is script's job.
    argv0 = rules.namesFile === true ? texts[0] : undefined
  } else {
    args = []
    argv0 = rules.bareStdin
  }
  if (code === null && script !== null) {
    if (ctx.vfs === undefined) return failed(`${label}: no dispatch available to read script\n`)
    // Read by the key its mount gives it, which the dispatcher reads by.
    const keyed = new PathSpec({
      virtual: script.virtual,
      directory: script.directory,
      pattern: script.pattern,
      resolved: script.resolved,
      vfsPath: mountKey(script.virtual, mountPrefixOf(script.virtual, script.vfsPath)),
    })
    let data: unknown
    try {
      ;[data] = await ctx.vfs.dispatch('read', keyed)
    } catch (err) {
      if (!isMissingPath(err)) throw err
      return failed(`${label}: ${script.virtual}: No such file\n`)
    }
    const bytes =
      data instanceof Uint8Array
        ? data
        : data === null || data === undefined
          ? new Uint8Array()
          : await materialize(data as ByteSource)
    code = decoder.decode(bytes)
    if (flags.x === true) code = skipFirstLine(code)
  }
  let stdin = ctx.stdin
  if (code === null) {
    const source = stdin === null ? null : await materialize(stdin)
    if (source === null || source.length === 0) return failed(`${label}: no input\n`)
    code = decoder.decode(source)
    stdin = null
  }
  const scriptCli = flags.scriptCli === true
  if (scriptCli && ctx.spec !== undefined) argv0 = ctx.spec.name
  return {
    code,
    args,
    ...(argv0 !== undefined ? { prog: argv0 } : {}),
    stdin,
    ...(script !== null ? { scriptPath: script } : {}),
    scriptCli,
  }
}
