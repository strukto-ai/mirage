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

import { SHELL_SPECS, parseShellOptions } from '../../commands/spec/shell.ts'
import { parseBashArgs } from '../executor/builtins/script/bash.ts'

/**
 * One word of a line as the gate reads it: `raw` as typed, `text` what
 * it names before expansion (quotes removed, escapes resolved), null
 * when only the runtime can say (a parameter or command substitution,
 * a brace expansion).
 */
export interface Word {
  readonly raw: string
  readonly text: string | null
}

/** The text the gate works with: the literal when it has one, the word as typed otherwise. */
export function wordValue(word: Word): string {
  return word.text ?? word.raw
}

function valueAt(args: readonly Word[], index: number): string {
  const word = args[index]
  return word === undefined ? '' : wordValue(word)
}

/**
 * A line a command runs on the words it was given. Exactly one shape
 * applies. `line` is text the runtime parses afresh (`eval`'s joined
 * words, `sh -c`'s program, `mapfile -C`'s callback); `argv` is a
 * command already split into words (`command`, `exec`, `env`,
 * `timeout`, `xargs`, `find -exec`, `nohup`, `nice`, `time`); neither
 * is a line the gate cannot read at all (a sourced file, a script, a
 * program from stdin). `open` says the runtime appends operands the
 * gate cannot read (`xargs`'s items, `find`'s `{}` paths, the index and
 * record `mapfile -C` hands its callback).
 */
export interface InnerLine {
  readonly line: string | null
  readonly argv: readonly Word[]
  readonly open: boolean
}

const UNREADABLE: InnerLine = { line: null, argv: [], open: false }

function asLine(line: string, open = false): InnerLine {
  return { line, argv: [], open }
}

function asArgv(argv: readonly Word[], open = false): InnerLine[] {
  return argv.length > 0 ? [{ line: null, argv, open }] : []
}

/** Whether the gate can read what runs. */
export function innerReadable(inner: InnerLine): boolean {
  return inner.line !== null || inner.argv.length > 0
}

const FIND_EXEC: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const ENV_FLAGS: ReadonlySet<string> = new Set(['-i', '--ignore-environment', '-0', '--null', '-'])

function tail(args: readonly Word[], count: number): Word[] {
  return count > 0 ? args.slice(args.length - count) : []
}

// `command [-pVv] name [arg ...]`: `-v`/`-V` only report.
function commandInner(args: readonly Word[]): InnerLine[] {
  let i = 0
  while (i < args.length && valueAt(args, i).startsWith('-')) {
    const word = valueAt(args, i)
    i += 1
    if (word === '--') break
    if (word.includes('v') || word.includes('V')) return []
  }
  return asArgv(args.slice(i))
}

// `exec [-cl] [-a name] [command [arg ...]]`.
function execInner(args: readonly Word[]): InnerLine[] {
  let i = 0
  while (i < args.length && valueAt(args, i).startsWith('-')) {
    const word = valueAt(args, i)
    i += 1
    if (word === '--') break
    if (word.endsWith('a')) i += 1
  }
  return asArgv(args.slice(i))
}

// `env [-i] [-u NAME]... [NAME=VALUE]... [command [arg]...]`, read the
// way the tree's `env` builtin reads it.
function envInner(args: readonly Word[]): InnerLine[] {
  let i = 0
  while (i < args.length) {
    const word = valueAt(args, i)
    if (word === '--') {
      i += 1
      break
    }
    if (ENV_FLAGS.has(word) || word.startsWith('--unset=')) {
      i += 1
      continue
    }
    if (word === '-u' || word === '--unset') {
      i += 2
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      // A cluster ending in `u` takes the next word as the name.
      i += word.endsWith('u') ? 2 : 1
      continue
    }
    break
  }
  while (i < args.length) {
    const word = valueAt(args, i)
    if (!word.includes('=') || word.startsWith('=')) break
    i += 1
  }
  return asArgv(args.slice(i))
}

// The operands of a shell builtin with a spec, as Words; null when the
// line fails its own option parse.
function specOperands(spec: 'timeout' | 'xargs', args: readonly Word[]): Word[] | null {
  const parsed = parseShellOptions(SHELL_SPECS[spec], args.map(wordValue))
  if (parsed.invalid !== null || parsed.needsValue !== null) return null
  return tail(args, parsed.operands.length)
}

// `timeout [OPTION] DURATION COMMAND [ARG]...`.
function timeoutInner(args: readonly Word[]): InnerLine[] {
  const operands = specOperands('timeout', args)
  if (operands === null || operands.length < 2) return []
  return asArgv(operands.slice(1))
}

// `xargs [OPTION]... [COMMAND [INITIAL-ARGS]]`, `echo` when none, items
// from stdin appended.
function xargsInner(args: readonly Word[]): InnerLine[] {
  const operands = specOperands('xargs', args)
  if (operands === null) return []
  return asArgv(operands.length > 0 ? operands : [{ raw: 'echo', text: 'echo' }], true)
}

// `mapfile -C callback`: the callback is evaluated per quantum.
function mapfileInner(args: readonly Word[]): InnerLine[] {
  const parsed = parseShellOptions(SHELL_SPECS.mapfile, args.map(wordValue))
  const callback = parsed.flags.C
  return typeof callback === 'string' ? [asLine(callback, true)] : []
}

// `find ... -exec COMMAND [ARG]... ;` (and `-execdir`, `-ok`, `-okdir`,
// `+`), the matched paths appended.
function findInner(args: readonly Word[]): InnerLine[] {
  const inner: InnerLine[] = []
  let i = 0
  while (i < args.length) {
    if (!FIND_EXEC.has(valueAt(args, i))) {
      i += 1
      continue
    }
    i += 1
    const start = i
    while (i < args.length && ![';', '+'].includes(valueAt(args, i))) i += 1
    inner.push(...asArgv(args.slice(start, i), true))
  }
  return inner
}

// `nice [-n N] COMMAND [ARG]...`.
function niceInner(args: readonly Word[]): InnerLine[] {
  let i = 0
  while (i < args.length && valueAt(args, i).startsWith('-')) {
    const word = valueAt(args, i)
    i += 1
    if (word === '--') break
    if (word === '-n' || word === '--adjustment') i += 1
  }
  return asArgv(args.slice(i))
}

// `time [-p] COMMAND [ARG]...`.
function timeInner(args: readonly Word[]): InnerLine[] {
  let i = 0
  while (i < args.length && ['-p', '--'].includes(valueAt(args, i))) i += 1
  return asArgv(args.slice(i))
}

// `nohup COMMAND [ARG]...`.
function nohupInner(args: readonly Word[]): InnerLine[] {
  const first = args[0]
  return asArgv(first !== undefined && wordValue(first) === '--' ? args.slice(1) : args)
}

// `builtin shell-builtin [ARG]...`: the named builtin runs with the
// words as given (bash takes no options here but still honors a leading
// `--`), so `builtin eval 'rm x'` is `eval`'s line.
function builtinInner(args: readonly Word[]): InnerLine[] {
  const first = args[0]
  return asArgv(first !== undefined && wordValue(first) === '--' ? args.slice(1) : args)
}

// `sh`/`bash`: `-c` names the program; a script file or a program read
// from stdin is a line the gate cannot read.
function shellInner(args: readonly Word[]): InnerLine[] {
  const parsed = parseBashArgs(args.map(wordValue))
  if (parsed.invalid !== null || parsed.needsValue !== null) return []
  if (parsed.script !== null) return [asLine(parsed.script)]
  return [UNREADABLE]
}

/**
 * The lines a command runs on the words it was given, for the words
 * that run other words.
 *
 * The table is the workspace shell's own re-dispatchers (every builtin
 * that hands a constructed line back to the evaluator: `eval`, `source`,
 * `command`, `env`, `timeout`, `xargs`, `mapfile -C`, `sh`/`bash`, an
 * executed path) plus the classic prefix runners a real shell has and
 * the workspace shell does not (`builtin`, `exec`, `nohup`, `nice`,
 * `time`, `find -exec`). A whole-line runtime is a real shell, so
 * anything else that
 * can run a command (an interpreter's `-c`, `make`, `git` hooks) is the
 * runtime's own world: the allow list is the closed form there.
 */
export function innerLines(head: string, args: readonly Word[]): InnerLine[] {
  if (head.includes('/')) return [UNREADABLE]
  switch (head) {
    case 'eval':
      return args.length > 0 ? [asLine(args.map(wordValue).join(' '))] : []
    case 'source':
    case '.':
      return args.length > 0 ? [UNREADABLE] : []
    case 'sh':
    case 'bash':
      return shellInner(args)
    case 'command':
      return commandInner(args)
    case 'builtin':
      return builtinInner(args)
    case 'exec':
      return execInner(args)
    case 'env':
      return envInner(args)
    case 'timeout':
      return timeoutInner(args)
    case 'xargs':
      return xargsInner(args)
    case 'mapfile':
    case 'readarray':
      return mapfileInner(args)
    case 'find':
      return findInner(args)
    case 'nice':
      return niceInner(args)
    case 'time':
      return timeInner(args)
    case 'nohup':
      return nohupInner(args)
    default:
      return []
  }
}
