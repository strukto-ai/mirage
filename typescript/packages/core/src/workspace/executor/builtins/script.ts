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

import { resolvePath } from '../../../utils/path.ts'
import { materialize, IOResult } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import { SET_FLAG_TO_OPTION } from '../../../shell/types.ts'
import { FileType } from '../../../types.ts'
import type { PathSpec } from '../../../types.ts'
import { fsStrerror, isFsError } from '../../../utils/errors.ts'
import type { Session } from '../../session/session.ts'
import { sleep } from '../../abort.ts'
import { ExecutionNode } from '../../types.ts'
import type { DispatchFn } from '../cross_mount.ts'
import { resolvePathStat } from './links.ts'
import { toScope, scopePath } from './scope.ts'
import type { Result, ExecuteStringFn } from './scope.ts'

export async function handleEval(
  executeFn: ExecuteStringFn,
  args: string[],
  session: Session,
): Promise<Result> {
  const script = args.join(' ')
  const io = await executeFn(script, { sessionId: session.sessionId })
  return [io.stdout, io, new ExecutionNode({ command: 'eval', exitCode: io.exitCode })]
}

// Startup flags with nothing to configure in an embedded shell: there is no
// login profile, no rc file and no tty. Flags that name a `set` option
// (-e -u -x -f) are not here; they are applied through SET_FLAG_TO_OPTION.
const BASH_NOOP_SHORT_FLAGS = new Set(['l', 'i'])
const BASH_NOOP_LONG_FLAGS = new Set(['--login', '--norc', '--noprofile', '--posix', '--rcfile'])

function bashError(name: string, message: string, code: number): Result {
  const err = new TextEncoder().encode(`${name}: ${message}\n`)
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: name, exitCode: code, stderr: err }),
  ]
}

export interface BashArgs {
  // Inline program text from `-c`.
  script: string | null
  // Script file operand, as typed.
  path: string | null
  // Words after the program: `$0` first for the `-c` form, all
  // positional for the file form.
  argv: string[]
  // Shell options the startup flags turn on.
  options: string[]
  // Whether `-s` was given.
  readStdin: boolean
  // A ready usage failure, when parsing failed.
  error: Result | null
}

function bashArgs(partial: Partial<BashArgs>): BashArgs {
  return {
    script: null,
    path: null,
    argv: [],
    options: [],
    readStdin: false,
    error: null,
    ...partial,
  }
}

function setOptions(chars: string): string[] {
  const options: string[] = []
  for (let j = 0; j < chars.length; j++) {
    const option = SET_FLAG_TO_OPTION[chars.charAt(j)]
    if (option !== undefined) options.push(option)
  }
  return options
}

/**
 * Split a `bash`/`sh` argument list into flags, program and argv.
 *
 * Option parsing stops at the first operand, so everything after a script
 * file (or after `-c`'s program text) is positional, even when it looks
 * like a flag: `bash run.sh -c foo` passes `-c foo` to the script.
 */
export function parseBashArgs(name: string, args: string[]): BashArgs {
  const options: string[] = []
  let readStdin = false
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (tok === '-s') {
      readStdin = true
      i += 1
      continue
    }
    if (tok === '-o' || tok === '+o') {
      i += 2
      continue
    }
    if (BASH_NOOP_LONG_FLAGS.has(tok)) {
      i += 1
      continue
    }
    if (!(tok.startsWith('-') && tok.length > 1 && !tok.startsWith('--'))) break
    const chars = tok.slice(1)
    if (chars.includes('c')) {
      const next = args[i + 1]
      if (next === undefined) {
        return bashArgs({ error: bashError(name, '-c: option requires an argument', 2) })
      }
      options.push(...setOptions(chars))
      return bashArgs({ script: next, argv: args.slice(i + 2), options, readStdin })
    }
    let known = true
    for (let j = 0; j < chars.length; j++) {
      const ch = chars.charAt(j)
      if (BASH_NOOP_SHORT_FLAGS.has(ch) || ch === 's' || SET_FLAG_TO_OPTION[ch] !== undefined) {
        continue
      }
      known = false
      break
    }
    if (!known) return bashArgs({ error: bashError(name, `${tok}: unsupported option`, 2) })
    options.push(...setOptions(chars))
    readStdin = readStdin || chars.includes('s')
    i += 1
  }
  if (i < args.length) {
    return bashArgs({ path: args[i] ?? '', argv: args.slice(i + 1), options, readStdin })
  }
  return bashArgs({ options, readStdin })
}

/**
 * Read a script file operand, or the failure bash reports for it.
 *
 * GNU splits the diagnostics by how far startup got. A file it cannot open
 * is blamed on the shell (`bash: run.sh: No such file or directory`, exit
 * 127; `Permission denied`, exit 126), while a directory opens fine and
 * only fails on the first read, by which point `$0` is already the operand,
 * so bash prints it twice (`/tmp: /tmp: Is a directory`, exit 126).
 * Reproduced rather than tidied up: it is what an agent copying a message
 * into a search box will find.
 *
 * A backend that cannot tell a missing path from an unreadable one raises
 * ENOENT for a directory too, so the stat probe runs on the failure path to
 * recover the distinction.
 */
async function readScriptFile(
  dispatch: DispatchFn,
  name: string,
  path: string,
  session: Session,
): Promise<[string, null] | [null, Result]> {
  const scope = toScope(resolvePath(path, session.cwd))
  let data: unknown
  try {
    ;[data] = await dispatch('read', scope)
  } catch (exc) {
    if (!isFsError(exc)) throw exc
    const stat = await resolvePathStat(dispatch, scope)
    if (stat !== null && stat.type === FileType.DIRECTORY) {
      return [null, bashError(path, `${path}: Is a directory`, 126)]
    }
    const strerror = fsStrerror(exc) ?? 'No such file or directory'
    const code = (exc as { code?: string }).code === 'EACCES' ? 126 : 127
    return [null, bashError(name, `${path}: ${strerror}`, code)]
  }
  if (data instanceof Uint8Array) return [new TextDecoder().decode(data), null]
  if (data === null || data === undefined) return ['', null]
  const collected = await materialize(data as ByteSource)
  return [new TextDecoder().decode(collected), null]
}

/**
 * Run a nested shell: inline text from `-c`, or a script file.
 *
 * `name` is the head word (`bash` or `sh`). bash reports itself by
 * `argv[0]`, so the diagnostics follow the spelling the caller used.
 */
export async function handleBash(
  dispatch: DispatchFn,
  executeFn: ExecuteStringFn,
  args: string[],
  session: Session,
  stdin: ByteSource | null = null,
  name = 'bash',
): Promise<Result> {
  const parsed = parseBashArgs(name, args)
  if (parsed.error !== null) return parsed.error
  let script = parsed.script
  let scriptName = script !== null && parsed.argv.length > 0 ? (parsed.argv[0] ?? name) : name
  const positional = script !== null ? parsed.argv.slice(1) : parsed.argv
  if (script === null && parsed.path !== null) {
    scriptName = parsed.path
    const [text, failure] = await readScriptFile(dispatch, name, parsed.path, session)
    if (failure !== null) return failure
    script = text
  }
  if (script === null && parsed.readStdin && stdin !== null) {
    const data = await materialize(stdin)
    if (data.length > 0) {
      script = new TextDecoder().decode(data)
      stdin = null
    }
  }
  if (script === null) {
    return [null, new IOResult(), new ExecutionNode({ command: name, exitCode: 0 })]
  }
  const savedPositional = session.positionalArgs
  const savedScriptName = session.scriptName
  const savedOptions = { ...session.shellOptions }
  session.positionalArgs = positional
  session.scriptName = scriptName
  for (const option of parsed.options) session.shellOptions[option] = true
  let io
  try {
    io = await executeFn(script, { sessionId: session.sessionId, stdin })
  } finally {
    session.positionalArgs = savedPositional
    session.scriptName = savedScriptName
    session.shellOptions = savedOptions
  }
  const label = parsed.path !== null ? `${name} ${parsed.path}` : `${name} -c ${script}`
  return [io.stdout, io, new ExecutionNode({ command: label, exitCode: io.exitCode })]
}

export async function handleSource(
  dispatch: DispatchFn,
  executeFn: ExecuteStringFn,
  path: string | PathSpec,
  session: Session,
  args: string[] = [],
): Promise<Result> {
  const raw = scopePath(path)
  const resolved = resolvePath(raw, session.cwd)
  const scope = toScope(resolved)
  let script = ''
  try {
    const [data] = await dispatch('read', scope)
    if (data instanceof Uint8Array) {
      script = new TextDecoder().decode(data)
    } else if (data !== null && data !== undefined) {
      // ByteSource: collect into a string
      const chunks: number[] = []
      for await (const chunk of data as AsyncIterable<Uint8Array>) {
        for (const b of chunk) chunks.push(b)
      }
      script = new TextDecoder().decode(new Uint8Array(chunks))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode(`source: ${raw}: ${msg}\n`),
      }),
      new ExecutionNode({ command: `source ${raw}`, exitCode: 1 }),
    ]
  }
  let savedPositional: string[] | null = null
  if (args.length > 0) {
    savedPositional = session.positionalArgs
    session.positionalArgs = args
  }
  session.sourceDepth += 1
  try {
    const io = await executeFn(script, { sessionId: session.sessionId })
    return [io.stdout, io, new ExecutionNode({ command: `source ${raw}`, exitCode: io.exitCode })]
  } finally {
    session.sourceDepth -= 1
    if (savedPositional !== null) session.positionalArgs = savedPositional
  }
}

// Finite non-negative decimals only ("0", "0.2", ".5", "1.", "+1", "1e-3").
// GNU sleep additionally accepts "inf" and sleeps forever; an agent shell
// must never hang, so non-finite intervals are rejected (deliberate
// divergence). The regex also keeps Python/TypeScript parsing identical:
// Number() alone would accept "0x10", "Infinity", and the empty string that
// float() rejects, and float() accepts "inf", "nan", and "1_0".
const SLEEP_INTERVAL = /^\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

export async function handleSleep(args: string[], signal?: AbortSignal): Promise<Result> {
  const raw = args[0]
  if (raw === undefined) {
    const err = new TextEncoder().encode('sleep: missing operand\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  // "1e309" passes the regex but overflows to Infinity, so check both.
  const seconds = SLEEP_INTERVAL.test(raw) ? Number(raw) : Infinity
  if (!Number.isFinite(seconds)) {
    const err = new TextEncoder().encode(`sleep: invalid time interval '${raw}'\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  await sleep(seconds * 1000, signal)
  return [null, new IOResult(), new ExecutionNode({ command: 'sleep', exitCode: 0 })]
}
