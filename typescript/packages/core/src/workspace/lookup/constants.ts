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

import { directoriesAction } from '../../commands/builtin/generic/grep.ts'
import { linkMode } from '../../commands/builtin/generic/ls.ts'
import { walksDescendantMounts } from '../../commands/builtin/generic/rg.ts'
import { sedWrites } from '../../commands/builtin/generic/sed.ts'
import { FlagView, SPECS, parseCommand } from '../../commands/spec/index.ts'
import { parseToKwargs } from '../../commands/spec/parser.ts'
import type { FlagValue } from '../../commands/spec/types.ts'
import { compileSpec } from '../../commands/spec/compile.ts'
import { BUILTIN_GROUP } from '../../shell/constants.ts'
import { BuiltinGroup, ShellBuiltin } from '../../shell/types.ts'
import type { LsLinkMode, PathSpec } from '../../types.ts'

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

// Commands with lstat semantics: they act on the symlink entry itself,
// so dispatch must not rewrite their operands through the link table.
// `stat`, `file` and `du` are here because GNU lstats for all three,
// but each takes -L to dereference after all, which `dereferences`
// reads back out of the command line.
//
// `tar` and `zip` are here for a different reason and deliberately
// carry no DEREFERENCE_FLAGS entry: they dereference too, but their
// planner has to be the one doing it. Rewriting the operand up here
// would hand the planner a target it can no longer tell was reached
// through a link, so `tar` could not store a symlink member at all and
// neither archiver could apply its own cross-mount refusal or ELOOP
// wording. tar's -h and zip's -y are read by the planner instead.
const NO_FOLLOW_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'mv',
  'ln',
  'readlink',
  'rmdir',
  'unlink',
  'stat',
  'file',
  'du',
  'find',
  'tar',
  'zip',
])

// Per-command option that turns a no-follow command back into a following
// one (GNU's -L), then the one that takes it back, the last of the two
// winning: `du -LP` does not follow, `du -PL` does, and so for file's -L
// and -h (file 5.46). Each is the option's dest in the command's spec,
// read off the parsed line, so a long spelling and its abbreviation count
// as the short one does (`stat --deref`).
const DEREFERENCE_FLAGS: Record<string, readonly string[]> = {
  stat: ['dereference'],
  file: ['L', 'h'],
  du: ['L', 'P'],
}

// find states its link policy as a leading option rather than a flag,
// and the last one wins: `find -L -P x` does not follow, `find -P -L x`
// does. -P (no follow) is the default; -H dereferences the start point
// only and -L dereferences everything, so both follow the operand. Only
// the run of options before the first operand counts, which is where GNU
// accepts them.
const LAST_WINS_LINK_OPTIONS: Record<string, Record<string, boolean>> = {
  find: { '-P': false, '-H': true, '-L': true },
}

// Resolve a leading run of link options to its last one's mode. The
// lookup doubles as the loop's stop condition, so the first word that is
// not a link option ends the run without a second membership test.
function lastLinkOption(
  words: readonly (string | PathSpec)[],
  policy: Record<string, boolean>,
): boolean {
  let follows = false
  for (const word of words.slice(1)) {
    if (typeof word !== 'string') break
    const mode = policy[word]
    if (mode === undefined) break
    follows = mode
  }
  return follows
}

// Whether a no-follow command was asked to dereference after all.
export function dereferences(name: string, words: readonly (string | PathSpec)[]): boolean {
  const policy = LAST_WINS_LINK_OPTIONS[name]
  if (policy !== undefined) return lastLinkOption(words, policy)
  const options = DEREFERENCE_FLAGS[name]
  if (options === undefined) return false
  const fl = new FlagView(lineFlags(name, words), SPECS[name])
  return fl.typedOrder(...options).at(-1) === options[0]
}

/**
 * Which command-line links an `ls` line resolves before it lists. Read off
 * the parsed line rather than scanned, because ls's own rule turns on the
 * last of several options, some of them valued and any of them abbreviated
 * (`--cl`, `--indicator-style=classify`); the rule itself is the ls
 * generic's `linkMode`. Mirrors Python's ls_link_mode.
 */
export function lsLinkMode(words: readonly (string | PathSpec)[]): LsLinkMode {
  return linkMode(new FlagView(lineFlags('ls', words), SPECS.ls))
}

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

/**
 * Whether a command's traversal enters the mounts below its operands; a
 * wrapper walks as the program it runs. What the admission gate stamps as
 * `CommandContext.walks`, so a mount rule can speak on an ancestor operand,
 * and what the executor's fan-out reruns in each descendant mount: one
 * answer for both, so a line the fan-out carries into a mount is one its
 * rule was asked about. `du -x`, `tree -x` and `rg --one-file-system` keep
 * to the operand's mount. `tar` and `zip` walk too but refuse to cross a
 * mount boundary, so a mount rule has nothing to say about them. Mirrors
 * Python's walks_mounts.
 */
export function walksMounts(name: string, bag: Record<string, FlagValue>): boolean {
  const runs = EXEC_WRAPPERS.get(name)?.[0] ?? name
  if (runs === 'find') return true
  if (runs === 'rg') return walksDescendantMounts(bag)
  if (!['du', 'tree', 'ls', 'grep'].includes(runs)) return false
  const fl = new FlagView(bag, SPECS[runs])
  if (runs === 'du') return !fl.asBool('one_file_system')
  if (runs === 'tree') return !fl.asBool('x')
  if (runs === 'ls') return fl.asBool('recursive')
  return directoriesAction(fl) === 'recurse'
}

/**
 * Whether a command reads below the paths its words name: the walkers
 * above, plus the subtree readers that stop at a mount boundary (`tar -c`,
 * `zip -r`, `cp -r`, `cp -a`). What the whole-line gate reads: a runtime
 * does its own walking where no entry gate follows, so a path rule that
 * scopes such a command refuses the captured line instead of running it
 * unguarded. Mirrors Python's reads_subtrees.
 */
export function readsSubtrees(name: string, bag: Record<string, FlagValue>): boolean {
  if (walksMounts(name, bag)) return true
  if (!['tar', 'zip', 'cp'].includes(name)) return false
  const fl = new FlagView(bag, SPECS[name])
  if (name === 'tar') return fl.asBool('create')
  if (name === 'zip') return fl.asBool('r')
  return ['r', 'recursive', 'archive'].some((d) => fl.asBool(d))
}

// The builtins whose declared write `changesFiles` narrows by line.
const NARROWED_WRITES: ReadonlySet<string> = new Set([
  'sort',
  'shuf',
  'iconv',
  'uniq',
  'xxd',
  'tee',
  'mktemp',
  'tar',
  'unzip',
  'gzip',
  'gunzip',
  'sed',
])

/**
 * Whether this run of a builtin may change files, read off its words: the
 * narrowing of a builtin's declared `write` that its options make. `sort
 * -o`, `shuf -o` and `iconv -o` write their output file and `uniq` and
 * `xxd` their second operand; `sed` writes under `-i`, a `w` file in its
 * script or a script file (unread here, so assumed to); `tar` writes to
 * create or extract, not to list or to extract to stdout; `unzip` writes
 * unless it lists, tests or pipes; `gzip` and `gunzip` write a file operand
 * unless `-c` or `-t`; `tee` writes the files it names; `mktemp -u` creates
 * nothing. Every other name may write whenever its handler declares so.
 * Mirrors Python's changes_files.
 */
export function changesFiles(name: string, words: readonly (string | PathSpec)[]): boolean {
  const spec = SPECS[name]
  if (!NARROWED_WRITES.has(name) || spec === undefined) return true
  const argv = words.slice(1).map((w) => (typeof w === 'string' ? w : w.rawPath))
  const parsed = parseCommand(spec, argv, '/', name)
  const bag = parseToKwargs(parsed)
  const fl = new FlagView(bag, spec)
  const operands = parsed.args.length
  switch (name) {
    case 'sort':
    case 'shuf':
      return fl.raw('output') !== undefined
    case 'iconv':
      return fl.raw('o') !== undefined
    case 'uniq':
    case 'xxd':
      return operands > 1
    case 'tee':
      return operands > 0
    case 'mktemp':
      return !fl.asBool('dry_run')
    case 'tar':
      return fl.asBool('create') || (fl.asBool('extract') && !fl.asBool('to_stdout'))
    case 'unzip':
      return !['args_l', 't', 'v', 'p', 'Z'].some((d) => fl.asBool(d))
    case 'gzip':
      return operands > 0 && !fl.asBool('c')
    case 'gunzip':
      return operands > 0 && !(fl.asBool('c') || fl.asBool('t'))
    default:
      return sedWrites(bag, parsed.texts())
  }
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

// Whether a command resolves its operand's final component itself. The
// directory prefix is resolved for every command, so this is only about
// the last one: open(2) semantics (true) against lstat(2) (false). A
// trailing slash overrides a false per operand, which is `followPaths`'
// job because the slash is a property of the operand rather than of the
// command.
export function followsLastComponent(name: string, words: readonly (string | PathSpec)[]): boolean {
  // A link to a directory is resolved only once a stat has shown where it
  // leads, which the router does itself; what this answers for ls is whether
  // the line may resolve one at all.
  if (name === 'ls') return lsLinkMode(words) !== 'none'
  if (SELF_RESOLVING.has(name)) return false
  return !NO_FOLLOW_COMMANDS.has(name) || dereferences(name, words)
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
