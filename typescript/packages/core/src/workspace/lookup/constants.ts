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

import { linkMode } from '../../commands/builtin/generic/ls.ts'
import { declaredFacts } from '../../commands/builtin/generic_bind/factory.ts'
import { FlagView, SPECS, WordKind, parseCommand } from '../../commands/spec/index.ts'
import { parseToKwargs } from '../../commands/spec/parser.ts'
import type { FlagValue } from '../../commands/spec/types.ts'
import { compileSpec } from '../../commands/spec/compile.ts'
import { BUILTIN_GROUP } from '../../shell/constants.ts'
import { BuiltinGroup, ShellBuiltin } from '../../shell/types.ts'
import { Follow, LineFacts, type LsLinkMode, type PathSpec } from '../../types.ts'

// Bash builtins the parser accepts but the executor cannot honor; they
// still lookup to the shell layer so the error names a capability gap.
export const UNSUPPORTED_BUILTINS: ReadonlySet<string> = new Set([
  'bg',
  'complete',
  'compgen',
  'ulimit',
])

export const NAMESPACE_COMMANDS: ReadonlySet<string> = new Set([
  'getfattr',
  'ln',
  'readlink',
  'setfattr',
])

// Programs the router answers by name from the mount table and the attr
// overlay (node/command_dispatch), with spec-classified words like a mount
// command's. No mount registers them, so lookup names them here for `type`,
// `command -v` and the /usr/bin listing.
export const ROUTED_COMMANDS: ReadonlySet<string> = new Set([
  'chgrp',
  'chmod',
  'chown',
  'df',
  'mount',
])

// The namespace and routed programs that change what they name. No mount
// registers them, so no handler declares the write; policy reads it here.
export const WRITING_PROGRAMS: ReadonlySet<string> = new Set([
  'chgrp',
  'chmod',
  'chown',
  'ln',
  'setfattr',
])

// The programs Debian ships as a script that runs another one with an option
// put first: egrep is `exec grep -E "$@"`, so grep is what parses the line and
// answers it, its refusals and --help included (grep 3.11, gzip 1.13). Each
// is a program wherever the one it runs is a mount command.
export const EXEC_WRAPPERS: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['egrep', ['grep', '-E']],
  ['fgrep', ['grep', '-F']],
  ['zegrep', ['zgrep', '-E']],
  ['zfgrep', ['zgrep', '-F']],
])

// Interpreter names select runtime adapters; session builtins stay in Mirage.
export const INTERPRETER_NAMES: ReadonlySet<string> = new Set(
  [...BUILTIN_GROUP]
    .filter(([, group]) => group === BuiltinGroup.INTERPRETERS)
    .map(([name]) => name),
)

// Shell words a native runtime's captures can take from the session: the
// interpreters, and the process tools whose host programs see that
// runtime's own processes rather than mirage's managed runners.
export const CAPTURABLE_BUILTINS: ReadonlySet<string> = new Set([
  ...INTERPRETER_NAMES,
  'ps',
  'kill',
])

// bash reserved words that mirage's grammar implements. The parser, not
// the executor, consumes them, so they never reach lookup; `type` reports
// them and the CLI registry refuses them as head words. `coproc` is omitted
// because its construct is not implemented.
export const KEYWORDS: ReadonlySet<string> = new Set([
  'time',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'in',
  'function',
  '{',
  '}',
  '!',
  '[[',
  ']]',
])

// ShellBuiltin subset handled through the job table in the executor.
export const JOB_BUILTINS: ReadonlySet<string> = new Set([
  'wait',
  'fg',
  'kill',
  'jobs',
  'disown',
  'ps',
])

/**
 * The flags a builtin's own grammar reads off its words, as the executor
 * will hand them to its handler; empty for a name with no builtin grammar.
 * A wrapper reads as the program it runs. The facts below are read off this
 * parse rather than scanned from the words, so an abbreviation, a long
 * spelling, a valued option and an option's attached value all read as the
 * handler will read them: `grep --recur` and `grep -d recurse` walk,
 * `grep -ephrase` does not. Mirrors Python's line_flags.
 */
export function lineFlags(
  name: string,
  words: readonly (string | PathSpec)[],
): Record<string, FlagValue> {
  const [runs, first] = EXEC_WRAPPERS.get(name) ?? [name, undefined]
  const spec = SPECS[runs]
  if (spec === undefined) return {}
  const argv = words.slice(1).map((w) => (typeof w === 'string' ? w : w.rawPath))
  return parseToKwargs(parseCommand(spec, first === undefined ? argv : [first, ...argv], '/', runs))
}

// Commands the router must not resolve the last component for, even
// under a trailing slash, because none of them acts on the link's
// target and each says so in its own words. GNU tar strips the slash
// and archives the link (`tar -cf a.tar dlink/` == `tar -cf a.tar
// dlink`; only -h descends). The four destructive ones refuse outright:
// `rm dlink/` is "Is a directory", `rm -r dlink/` and `mv dlink/ d` and
// `unlink dlink/` are "Not a directory", and `rmdir dlink/` has a
// message of its own, "Symbolic link not followed". Probed on GNU
// coreutils 9.4 / tar 1.35. mkdir is here for the same reason it is in
// SELF_RESOLVING: it lstats the name it is creating, so `mkdir -p
// dangle/` collides with the link exactly as `mkdir -p dangle` does.
// Info-ZIP is the counter-example and is deliberately absent:
// `zip -y -r a.zip dlink/` descends where `zip -y -r a.zip dlink`
// stores the link.
export const SLASH_KEEPS_LAST: ReadonlySet<string> = new Set([
  'tar',
  'rm',
  'rmdir',
  'mv',
  'unlink',
  'mkdir',
])

// Commands that decide the last component for themselves, so the router
// resolves only the prefix for them. chmod/chown/chgrp read -h off their
// own line (GNU `chgrp -h ops link` writes the link, not its target),
// touch reads -h the same way, ln is creating the name in its second
// operand, readlink's whole subject is the link it was handed, and
// mkdir is naming something that must not exist yet -- resolving its
// last component would make `mkdir -p dangle` create the link's missing
// target where GNU answers "File exists". getfattr and setfattr read -h
// off their own line and hand the dispatcher the link or its target.
// A trailing slash still applies to most of them: these are
// lstat-by-default, not slash-proof (`touch dlink/` succeeds against the
// target directory, `touch flink/` is "Not a directory"), which is why
// this is separate from SLASH_KEEPS_LAST.
const SELF_RESOLVING: ReadonlySet<string> = new Set([
  'chmod',
  'chown',
  'chgrp',
  'touch',
  'ln',
  'readlink',
  'mkdir',
  'getfattr',
  'setfattr',
])

const LS_FOLLOWS: Readonly<Record<LsLinkMode, Follow>> = {
  all: Follow.LAST,
  directory: Follow.DIRECTORY,
  none: Follow.NONE,
}

/**
 * An ls line resolves the command-line links `linkMode` says, and walks, and
 * reads, below its operands under `-R`. Mirrors Python's `_ls_facts`.
 */
function lsFacts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  const recursive = fl.asBool('recursive')
  return new LineFacts({
    follows: LS_FOLLOWS[linkMode(fl)],
    walks: recursive,
    readsSubtree: recursive,
  })
}

/**
 * What a line of a builtin does, read off its parsed flags by the command's
 * own facts; a wrapper does what the program it runs does. Mirrors Python's
 * `facts_of`.
 */
export function factsOf(
  name: string,
  bag: Record<string, FlagValue>,
  operands: readonly (string | PathSpec)[],
): LineFacts {
  const runs = EXEC_WRAPPERS.get(name)?.[0] ?? name
  const declared = runs === 'ls' ? lsFacts : declaredFacts(runs)
  const facts =
    declared instanceof LineFacts ? declared : declared(new FlagView(bag, SPECS[runs]), operands)
  if (SELF_RESOLVING.has(name)) return facts.with({ follows: Follow.NONE })
  return facts
}

/**
 * What a command line does, read off its words by the command's own grammar
 * and facts (`factsOf`), so an abbreviation, a long spelling and an option's
 * attached value read as the handler will read them: `grep --recur` and
 * `grep -d recurse` walk, `grep -ephrase` does not. A command that decides
 * its operand's last component itself (`SELF_RESOLVING`) follows no link.
 * An operand classified as a path carries whether it is a pattern still to
 * expand; `cwd` is what a path option's value (`mv -t`) resolves against.
 * Mirrors Python's `line_facts`.
 */
export function lineFacts(
  name: string,
  words: readonly (string | PathSpec)[],
  cwd: string,
): LineFacts {
  const [runs, first] = EXEC_WRAPPERS.get(name) ?? [name, undefined]
  const spec = SPECS[runs]
  if (spec === undefined || (runs !== 'ls' && declaredFacts(runs) instanceof LineFacts)) {
    return factsOf(name, {}, [])
  }
  const typed = first === undefined ? words.slice(1) : [first, ...words.slice(1)]
  const argv = typed.map((w) => (typeof w === 'string' ? w : w.rawPath))
  const parsed = parseCommand(spec, argv, cwd, runs)
  const operands = typed.filter((_, i) => parsed.wordRoles[i] === WordKind.OPERAND)
  return factsOf(name, parseToKwargs(parsed), operands)
}

// Options whose argument is a program, so the words after it are that
// program's argv rather than the command's own: python3's -c and -m
// (`python3 -c 'code' -u x` hands -u to the code). This is a table
// rather than a spec field on purpose. argparse cannot express it at
// all (`add_argument("-c")` beside `nargs=REMAINDER` answers
// `unrecognized arguments: -u`), and CPython parses its own command
// line in C for the same reason, so it is one command's rule and not
// part of the shared grammar.
const PROGRAM_OPTIONS: Record<string, readonly string[]> = {
  python: ['-c', '-m'],
  python3: ['-c', '-m'],
}

/**
 * Where a short cluster's program value ends, or null if it has none.
 *
 * Args:
 *   word: the option word, dash included.
 *   index: the word's position in the command's words.
 *   carriers: the spellings whose value is a program.
 *   valueSpellings: every short spelling that takes a value.
 */
function clusterHandoff(
  word: string,
  index: number,
  carriers: readonly string[],
  valueSpellings: readonly string[],
): number | null {
  for (let j = 1; j < word.length; j++) {
    const letter = `-${word[j] ?? ''}`
    // Attached (`-cCODE`) carries its value in this word; the detached
    // form takes the next one.
    if (carriers.includes(letter)) return word.slice(j + 1) !== '' ? index + 1 : index + 2
    if (valueSpellings.includes(letter)) return null
  }
  return null
}

/**
 * How many words a short cluster with no program value consumes.
 *
 * Args:
 *   word: the option word, dash included.
 *   valueSpellings: every short spelling that takes a value.
 */
function clusterWords(word: string, valueSpellings: readonly string[]): number {
  for (let j = 1; j < word.length; j++) {
    if (valueSpellings.includes(`-${word[j] ?? ''}`)) return word.slice(j + 1) !== '' ? 1 : 2
  }
  return 1
}

/**
 * Insert POSIX's `--` after a program-carrying option's value.
 *
 * The handoff already has a spelling every parser honors, so the rule is
 * applied by writing one down rather than by teaching the parser a new
 * kind of option. The marker is inserted unconditionally, never skipped
 * because the line already carries one: CPython stops parsing at -c and
 * passes a later `--` through as data (`python3 -c p -- -u` gives the
 * program `['-c', '--', '-u']`), so the parser must consume exactly the
 * one added here and leave any typed one alone.
 *
 * Only the option run before the first operand is scanned. A -c after an
 * operand belongs to the program (`python3 s.py -c x`), and the operand
 * already ended option parsing by itself.
 *
 * The scan walks a short cluster letter by letter rather than matching
 * the word's prefix, because the carrier need not be first: CPython
 * reads `python3 -uc 'p' -v` and `python3 -uc'p' -v` the same way it
 * reads the unclustered forms, handing `-v` to the program.
 */
export function endOptionsAfterProgram(name: string, words: string[]): string[] {
  const carriers = PROGRAM_OPTIONS[name]
  if (carriers === undefined) return words
  // Value spellings say which words carry a value, so `-W ignore -c p`
  // steps over `ignore` instead of reading it as the first operand.
  const spec = SPECS[name]
  if (spec === undefined) return words
  const compiled = compileSpec(spec)
  let i = 0
  while (i < words.length) {
    const word = words[i] ?? ''
    if (word === '--') return words
    // The first operand, which ended option parsing by itself.
    if (!word.startsWith('-') || word === '-') return words
    if (word.startsWith('--')) {
      const attached = word.includes('=')
      const longName = word.split('=', 1)[0] ?? word
      i += attached || !compiled.longValueSpellings.has(longName) ? 1 : 2
      continue
    }
    const after = clusterHandoff(word, i, carriers, compiled.valueSpellings)
    if (after === null) {
      i += clusterWords(word, compiled.valueSpellings)
      continue
    }
    // Nothing to hand over, and a detached form with no value at all is
    // the parser's refusal to report, not ours to turn into a program
    // named `--`.
    if (after >= words.length) return words
    return [...words.slice(0, after), '--', ...words.slice(after)]
  }
  return words
}

// bash 5.2's own builtins (`compgen -b` on debian:stable-slim). `type`
// calls one of these a shell builtin and `command -v` prints it bare,
// even where a program of the same name is on PATH too (echo, test,
// pwd); any other word mirage runs is a program, reported by its path.
export const BASH_BUILTINS: ReadonlySet<string> = new Set([
  '.',
  ':',
  '[',
  'alias',
  'bg',
  'bind',
  'break',
  'builtin',
  'caller',
  'cd',
  'command',
  'compgen',
  'complete',
  'compopt',
  'continue',
  'declare',
  'dirs',
  'disown',
  'echo',
  'enable',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fc',
  'fg',
  'getopts',
  'hash',
  'help',
  'history',
  'jobs',
  'kill',
  'let',
  'local',
  'logout',
  'mapfile',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'read',
  'readarray',
  'readonly',
  'return',
  'set',
  'shift',
  'shopt',
  'source',
  'suspend',
  'test',
  'times',
  'trap',
  'true',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
])

// The builtins that are the shell's own, which no program loader can
// find: `find -exec` execs through execvp and sees nothing the shell
// defined, so these heads are `find: 'cd': No such file or directory`
// (findutils 4.10 on debian:stable-slim, where `kill` is bash's alone
// since procps is absent), while `echo`, `sh`, `xargs` or `python3` are
// programs there as well as builtins here.
export const SHELL_ONLY_BUILTINS: ReadonlySet<string> = new Set([
  '.',
  ':',
  'alias',
  'bg',
  'break',
  'cd',
  'command',
  'compgen',
  'complete',
  'continue',
  'declare',
  'disown',
  'eval',
  'exec',
  'exit',
  'export',
  'fg',
  'getopts',
  'help',
  'history',
  'jobs',
  'kill',
  'let',
  'local',
  'mapfile',
  'read',
  'readarray',
  'readonly',
  'return',
  'set',
  'shift',
  'shopt',
  'source',
  'trap',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
])

export const SHELL_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(ShellBuiltin),
  ...UNSUPPORTED_BUILTINS,
])
