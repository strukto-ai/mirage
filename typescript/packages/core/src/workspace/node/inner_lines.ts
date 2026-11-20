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
import { getText, literalWord } from '../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { hasGlob, markEscapedGlobs } from '../../utils/glob_walk.ts'
import { patternShape } from '../../utils/fnmatch.ts'
import { parseBashArgs } from '../executor/builtins/script/bash.ts'
import { BASH_LONG_OPTIONS } from '../executor/builtins/script/constants.ts'
import { CondParser, PATTERN_OPS, condLeaves, condTokens } from './test_tokens.ts'
import { readWrapper } from '../lookup/constants.ts'
import { lookup, pathProgram } from '../lookup/lookup.ts'
import { Consumer } from '../lookup/types.ts'
import type { NamespaceLinks } from '../../view/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'

/**
 * One word of a line as the gate reads it: `raw` as typed, `text` what
 * it names before expansion (quotes removed, escapes resolved), null
 * when only the runtime can say (a parameter or command substitution,
 * a brace expansion).
 */
export interface Word {
  readonly raw: string
  readonly text: string | null
  /** An unquoted pathname pattern may erase or multiply this word. */
  readonly glob?: boolean
}

function wordGlobs(node: TSNodeLike): boolean {
  if (node.type === NT.WORD || node.type === NT.NUMBER) {
    return hasGlob(patternShape(markEscapedGlobs(getText(node))))
  }
  if (node.type === NT.COMMAND_NAME || node.type === NT.CONCATENATION) {
    return node.namedChildren.some(wordGlobs)
  }
  return node.type === NT.EXTGLOB_PATTERN
}

/**
 * Read a word without losing which glob characters are quoted. `globs` says
 * whether the runtime expands pathname patterns in this word; inside `[[ ]]`
 * it never does.
 */
export function readWord(
  node: TSNodeLike,
  homes: Readonly<Record<string, string>> | null = null,
  globs = true,
): Word {
  return { raw: getText(node), text: literalWord(node, homes), glob: globs && wordGlobs(node) }
}

/**
 * One test of a `[[ ]]` as the gate admits it: its opener, then
 * what it tests. `stated` says whether the gate admits it on these very
 * words once each is literal; a comparison's pattern side is read in the
 * matcher's dialect instead, so a question about one is left to the gate.
 */
export interface TestRead {
  readonly words: Word[]
  readonly stated: boolean
}

/**
 * A `[[ ]]` as the tests the gate admits, read with the tokens and the
 * grammar the run evaluates it by: a test per leaf, each admitted as the run
 * reaches it, since a branch never reached never expands; every reader of
 * the line reads the same leaves, so a question one asked is the one the
 * gate answers. No word of it expands a pathname pattern, so none is a glob,
 * and a pattern side with no expansion in it (an extglob or regex node) is
 * matched as typed, so it names its own text. (`[` is a command, admitted on
 * its words as any command is.) `homes` maps a name to the homes its tilde
 * names, `''` for a bare `~`. Mirrors Python's reads_of_test.
 */
export function readsOfTest(
  node: TSNodeLike,
  homes: Readonly<Record<string, string>> | null = null,
): TestRead[] {
  const opener: Word = { raw: '[[', text: '[[' }
  return condLeaves(new CondParser(condTokens(node)).parse()).map((leaf) => {
    let words: Word[]
    if (leaf.kind === 'unary') {
      words = [{ raw: leaf.op, text: leaf.op }, readWord(leaf.operand, homes, false)]
    } else if (leaf.kind === 'binary') {
      const right = readWord(leaf.right, homes, false)
      const typed = leaf.right.type === NT.EXTGLOB_PATTERN || leaf.right.type === NT.REGEX
      words = [
        readWord(leaf.left, homes, false),
        { raw: leaf.op, text: leaf.op },
        typed ? { raw: right.raw, text: right.raw } : right,
      ]
    } else {
      words = [readWord(leaf.operand, homes, false)]
    }
    const stated = leaf.kind !== 'binary' || !PATTERN_OPS.has(leaf.op)
    return { words: [opener, ...words], stated }
  })
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
  /** The folder the command runs in, as `cd` would take it (`env -C`). */
  readonly chdir?: Word | null
}

const UNREADABLE: InnerLine = { line: null, argv: [], open: false }

function asArgv(argv: readonly Word[], open = false): InnerLine[] {
  return argv.length > 0 ? [{ line: null, argv, open }] : []
}

/** Whether the gate can read what runs. */
export function innerReadable(inner: InnerLine): boolean {
  return inner.line !== null || inner.argv.length > 0
}

const FIND_EXEC: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const ENV_FLAGS: ReadonlySet<string> = new Set(['-i', '--ignore-environment', '-0', '--null', '-'])
const ENV_VALUED = ['unset', 'chdir', 'argv0'] as const
// Variables a whole line's shell expands or sources on its own.
export const HOOK_VARS: ReadonlySet<string> = new Set([
  'PS4',
  'BASH_ENV',
  'BASH_CMDS',
  'BASH_ALIASES',
])

/**
 * Whether a variable sets what a whole line's shell runs on its own: one it
 * expands or sources (`HOOK_VARS`), or a function bash imports from the
 * environment (`BASH_FUNC_NAME%%`).
 */
export function isHook(name: string): boolean {
  return HOOK_VARS.has(name) || name.startsWith('BASH_FUNC_')
}

function tail(args: readonly Word[], count: number): Word[] {
  return count > 0 ? args.slice(args.length - count) : []
}

// `command [-pVv] name [arg ...]`: `-v`/`-V` only report.
// `command [-pVv] name [arg ...]`: `-v`/`-V` only report; an option only the
// run expands may be either, so it is unreadable.
function commandInner(args: readonly Word[]): InnerLine[] {
  let i = 0
  while (i < args.length && valueAt(args, i).startsWith('-')) {
    if (args[i]?.text === null) return [UNREADABLE]
    const word = valueAt(args, i)
    i += 1
    if (word === '--') break
    if (word.includes('v') || word.includes('V')) return []
  }
  return asArgv(args.slice(i))
}

// `exec [-cl] [-a name] [command [arg ...]]`; `-l`, or a name starting with
// `-`, starts a shell as a login shell, which sources rc files the gate cannot
// read; an option only the run expands may be either, so it is unreadable.
function execInner(args: readonly Word[]): InnerLine[] {
  let i = 0
  while (i < args.length && valueAt(args, i).startsWith('-')) {
    if (args[i]?.text === null) return [UNREADABLE]
    const word = valueAt(args, i)
    i += 1
    if (word === '--') break
    if (word.includes('l')) return [UNREADABLE]
    if (word.endsWith('a')) {
      if (valueAt(args, i).startsWith('-')) return [UNREADABLE]
      i += 1
    }
  }
  return asArgv(args.slice(i))
}

// Whether an `env` word is GNU's `-S` / `--split-string`, whose value env
// splits into the command line itself.
function splits(word: string): boolean {
  if (word.startsWith('--')) {
    const name = word.slice(2).split('=', 1)[0] ?? ''
    return name !== '' && 'split-string'.startsWith(name)
  }
  if (!word.startsWith('-')) return false
  for (const flag of word.slice(1)) {
    if (flag === 'S') return true
    if ('uCa'.includes(flag)) return false
  }
  return false
}

// Whether an `env` option word takes the next word as its value: a detached
// `--unset`, `--chdir` or `--argv0` (or a prefix of one), or a cluster whose
// first of `u`, `C`, `a` ends it, since getopt hands such a letter the rest of
// its cluster when there is one.
function takesNext(word: string): boolean {
  if (word.startsWith('--')) {
    const [name = '', ...value] = word.slice(2).split('=')
    return value.length === 0 && name !== '' && ENV_VALUED.some((long) => long.startsWith(name))
  }
  for (let at = 1; at < word.length; at++) {
    if ('uCa'.includes(word[at] ?? '')) return at === word.length - 1
  }
  return false
}

// The folder an `env` option word sends its command to: `-C`'s or
// `--chdir`'s value, attached or the next word; null for any other option.
function valueOf(word: Word, after: Word | null, letter: string, long: string): Word | null {
  const value = wordValue(word)
  let attached: string
  if (value.startsWith('--')) {
    const [name = '', ...rest] = value.slice(2).split('=')
    if (name === '' || !long.startsWith(name)) return null
    if (rest.length === 0) return after
    attached = rest.join('=')
  } else {
    let at = 0
    while (at < value.length && !'uCa'.includes(value[at] ?? '')) at += 1
    if (at === 0 || at === value.length || value[at] !== letter) return null
    attached = value.slice(at + 1)
    if (attached === '') return after
  }
  return { raw: attached, text: word.text === null ? null : attached }
}

// `env [-i] [-u NAME]... [NAME=VALUE]... [command [arg]...]`, read the way
// the tree's `env` builtin reads it; an option only the run expands may be any
// of them, so it is unreadable.
function envInner(args: readonly Word[]): InnerLine[] {
  let chdir: Word | null = null
  let i = 0
  while (i < args.length) {
    const word = valueAt(args, i)
    if (word.startsWith('-') && args[i]?.text === null) return [UNREADABLE]
    if (word === '--') {
      i += 1
      break
    }
    if (splits(word)) return [UNREADABLE]
    if (ENV_FLAGS.has(word)) {
      i += 1
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      const current = args[i]
      if (current !== undefined) {
        chdir = valueOf(current, args[i + 1] ?? null, 'C', 'chdir') ?? chdir
        const argv0 = valueOf(current, args[i + 1] ?? null, 'a', 'argv0')
        // A leading `-` in argv0 makes a shell a login shell.
        if (argv0 !== null && wordValue(argv0).startsWith('-')) return [UNREADABLE]
      }
      i += takesNext(word) ? 2 : 1
      continue
    }
    break
  }
  while (i < args.length) {
    const word = valueAt(args, i)
    if (!word.includes('=') || word.startsWith('=')) break
    if (isHook(word.split('=', 1)[0] ?? '')) return [UNREADABLE]
    i += 1
  }
  const rest = args.slice(i)
  return rest.length > 0 ? [{ line: null, argv: rest, open: false, chdir }] : []
}

// The operands of a shell builtin with a spec, as Words; null when the
// line fails its own option parse.
function specOperands(spec: 'timeout' | 'xargs', args: readonly Word[]): Word[] | null {
  const parsed = parseShellOptions(SHELL_SPECS[spec], args.map(wordValue))
  if (parsed.invalid !== null || parsed.needsValue !== null || parsed.unexpectedValue !== null) {
    return null
  }
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
  const argv = operands.length > 0 ? operands : [{ raw: 'echo', text: 'echo' }]
  return asArgv(argv, true)
}

// `mapfile -C callback`: the callback is evaluated per quantum.
function mapfileInner(args: readonly Word[]): InnerLine[] {
  const parsed = parseShellOptions(SHELL_SPECS.mapfile, args.map(wordValue))
  const callback = parsed.flags.C
  return typeof callback === 'string' ? [{ line: callback, argv: [], open: true }] : []
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
    for (const item of asArgv(args.slice(start, i), true)) inner.push(item)
  }
  return inner
}

// `nice [-n N] COMMAND [ARG]...`.
// `nohup`, `nice`, `stdbuf`, `setsid` and `ionice` run what stands after
// their own options.
function wrapperInner(head: string, args: readonly Word[]): InnerLine[] {
  const [at] = readWrapper(
    head,
    args.map((_, i) => valueAt(args, i)),
  )
  return at === null ? [] : asArgv(args.slice(at))
}

// `time [-p] COMMAND [ARG]...`.
function timeInner(args: readonly Word[]): InnerLine[] {
  let i = 0
  while (i < args.length && ['-p', '--'].includes(valueAt(args, i))) i += 1
  return asArgv(args.slice(i))
}

// `builtin` runs the remaining words verbatim after an optional leading
// `--`.
function argvInner(args: readonly Word[]): InnerLine[] {
  const first = args[0]
  return asArgv(first !== undefined && wordValue(first) === '--' ? args.slice(1) : args)
}

// `sh`/`bash`: `-c` names the program and `--help` or `--version` runs
// nothing; a script file, a program read from stdin and a line mirage's
// parse refuses are lines the gate cannot read, since a real bash takes
// options mirage does not (`--restricted`, `-O extglob`) and still runs the
// program.
/**
 * Whether a shell's startup options make it interactive or a login shell
 * (`-i`, `-l`, `--login`), which sources rc files (`ENV`, `~/.bashrc`,
 * `~/.profile`) the gate cannot read.
 */
function startsRc(words: readonly string[]): boolean {
  let skip = false
  for (const word of words) {
    if (skip) {
      skip = false
      continue
    }
    if (word === '-' || word === '--' || !word.startsWith('-')) return false
    if (word.startsWith('--')) {
      if (word === '--login') return true
      skip = BASH_LONG_OPTIONS.get(word.slice(2)) === true
      continue
    }
    if (word.includes('i') || word.includes('l')) return true
    skip = 'oO'.includes(word.at(-1) ?? '')
  }
  return false
}

function shellInner(args: readonly Word[]): InnerLine[] {
  // Expansion can erase or split a word, shifting an option's value
  // onto --version or -c. Only a literal prefix can establish what
  // runs; dynamic positional words after its program cannot change it.
  const literal: string[] = []
  for (const word of args) {
    if (word.text === null || word.glob) break
    literal.push(word.text)
  }
  if (startsRc(literal)) return [UNREADABLE]
  const parsed = parseBashArgs(literal)
  if (parsed.help || parsed.version) return []
  if (parsed.script !== null) return [{ line: parsed.script, argv: [], open: false }]
  return [UNREADABLE]
}

// `trap [-lp] [[ACTION] CONDITION...]`: the action is a line the shell runs
// when a condition fires. `-` or a number first resets the conditions, a lone
// operand resets it, and an option only lists.
function trapInner(args: readonly Word[]): InnerLine[] {
  const first = args.length > 0 ? valueAt(args, 0) : ''
  if (first.startsWith('-') && first !== '-' && first !== '--') return []
  const rest = first === '--' ? args.slice(1) : args
  const action = rest.length > 0 ? valueAt(rest, 0) : ''
  if (rest.length < 2 || action === '-' || /^[0-9]+$/.test(action)) return []
  return [{ line: action, argv: [], open: false }]
}

// A builtin whose option `letter` loads what a later word runs from a file
// the gate cannot read (`hash -p`, `enable -f`).
function loads(args: readonly Word[], letter: string): InnerLine[] {
  for (const arg of args) {
    // The run may expand it to the loading option.
    if (arg.text === null) return [UNREADABLE]
    const word = wordValue(arg)
    if (word === '--' || !word.startsWith('-')) break
    if (word.slice(1).includes(letter)) return [UNREADABLE]
  }
  return []
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
 * runtime's own world: a closed tree is the closed form there.
 */
export function innerLines(head: string, args: readonly Word[]): InnerLine[] {
  if (head.includes('/')) return [UNREADABLE]
  switch (head) {
    case 'eval':
      return args.length > 0 ? [{ line: args.map(wordValue).join(' '), argv: [], open: false }] : []
    case 'source':
    case '.':
      return args.length > 0 ? [UNREADABLE] : []
    case 'sh':
    case 'bash':
      return shellInner(args)
    case 'command':
      return commandInner(args)
    case 'builtin':
      return argvInner(args)
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
    case 'nohup':
    case 'stdbuf':
    case 'setsid':
    case 'ionice':
      return wrapperInner(head, args)
    case 'time':
      return timeInner(args)
    case 'trap':
      return trapInner(args)
    case 'coproc':
      return asArgv(args)
    case 'hash':
      return loads(args, 'p')
    case 'enable':
      return loads(args, 'f')
    case 'alias':
      // A whole line's shell expands a later word to the value.
      return args.some(
        (w) =>
          w.text === null ||
          (w.text.includes('=') && !w.text.startsWith('=') && !w.text.startsWith('-')),
      )
        ? [UNREADABLE]
        : []
    default:
      return []
  }
}

/**
 * `innerLines` of a command, a `/usr/bin` path running its program on the
 * words after it, as the plain path runs it (`/usr/bin/python3 -c 1` runs
 * `python3 -c 1`). `links`, the session's, are followed to the file; null
 * reads the path as typed. `open` keeps the operands a runtime appends
 * (`xargs`) unread for the program. Mirrors Python's `program_lines`.
 */
export function programLines(
  words: readonly Word[],
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceLinks | null = null,
  open = false,
): InnerLine[] {
  const [first, ...args] = words
  if (first === undefined) return []
  const head = wordValue(first)
  if (runsFunction(head, session, registry)) return []
  const program = pathProgram(head, session, registry, links)
  if (program === null) return innerLines(head, args)
  return [{ line: null, argv: [{ raw: program, text: program }, ...args], open }]
}

/**
 * Whether a function of the head's name runs instead of it, so the words it
 * was given run nothing: the function's own lines each pass the gate as they
 * run (`timeout() { :; }; timeout 1 rm x`).
 */
export function runsFunction(
  head: string,
  session: SessionState,
  registry: MountRegistry,
): boolean {
  return (
    Object.hasOwn(session.functions, head) && lookup(head, session, registry) === Consumer.FUNCTION
  )
}
