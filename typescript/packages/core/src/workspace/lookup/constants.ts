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

import { SPECS } from '../../commands/spec/index.ts'
import { compileSpec } from '../../commands/spec/compile.ts'
import { ShellBuiltin } from '../../shell/types.ts'
import type { PathSpec } from '../../types.ts'

// Bash builtins the parser accepts but the executor cannot honor; they
// still lookup to the shell layer so the error names a capability gap.
export const UNSUPPORTED_BUILTINS: ReadonlySet<string> = new Set([
  'bg',
  'complete',
  'compgen',
  'ulimit',
])

export const NAMESPACE_COMMANDS: ReadonlySet<string> = new Set(['ln', 'readlink'])

// bash reserved words that mirage's grammar implements. The parser, not
// the executor, consumes them, so they never reach lookup; `type` reports
// them and the CLI registry refuses them as head words. bash's `time`
// and `coproc` are left out on purpose: mirage implements neither
// construct, so a line starting with one reports `command not found`,
// and `type` may not contradict what dispatch does. Add a word back when
// its construct lands.
export const KEYWORDS: ReadonlySet<string> = new Set([
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

// Per-command flags that turn a no-follow command back into a
// following one, GNU's -L / --dereference.
const DEREFERENCE_FLAGS: Record<string, [string, string[]]> = {
  stat: ['L', ['dereference']],
  file: ['L', ['dereference']],
  du: ['L', ['dereference']],
  ls: ['L', ['dereference']],
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

// The mirror: flags that make a following command report the link
// itself. GNU ls dereferences a command-line symlink to a directory,
// but -l and -d suppress that and show the link's own row instead.
const NO_FOLLOW_FLAGS: Record<string, [string, string[]]> = {
  ls: ['ld', []],
}

// Whether any of the given options appears among a command's words.
// Read off the command line rather than the parsed flags because
// operand rewriting happens before flag parsing. Only option words are
// inspected, so a format string like `-c '%L'` cannot trip it.
function hasOption(
  words: readonly (string | PathSpec)[],
  shorts: string,
  longs: string[],
): boolean {
  for (const word of words.slice(1)) {
    // Option words are always plain strings; path operands arrive as
    // PathSpec and can never be a flag.
    if (typeof word !== 'string') continue
    if (word === '--') return false
    if (word.startsWith('--')) {
      if (longs.includes(word.slice(2))) return true
      continue
    }
    if (word.startsWith('-')) {
      const cluster = word.slice(1)
      for (let i = 0; i < shorts.length; i++) {
        if (cluster.includes(shorts.charAt(i))) return true
      }
    }
  }
  return false
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
  const spec = DEREFERENCE_FLAGS[name]
  return spec !== undefined && hasOption(words, spec[0], spec[1])
}

// Whether a following command was asked to report links themselves.
function reportsLink(name: string, words: readonly (string | PathSpec)[]): boolean {
  if (dereferences(name, words)) return false
  const spec = NO_FOLLOW_FLAGS[name]
  return spec !== undefined && hasOption(words, spec[0], spec[1])
}

// Commands whose traversal descends into descendant mounts (the
// executor's fan-out reruns them per mount), always or under a flag.
// What the admission gate reads to stamp `CommandContext.walks`, so a
// mount rule can speak on an ancestor operand. `tar` and `zip` walk too
// but refuse to cross a mount boundary, so they are deliberately
// absent: a mount rule has nothing to say about a walk that never
// enters it.
const WALK_COMMANDS = new Set(['find', 'du', 'tree', 'rg'])
const WALK_FLAGS: Record<string, [string, string[]]> = {
  grep: ['rR', ['recursive']],
  ls: ['R', ['recursive']],
}

// Commands whose reads exceed the words the gate judged even inside one
// mount: the walkers above plus the subtree readers that stop at a
// mount boundary. What the whole-line gate reads: a runtime does its
// own walking where no entry gate follows, so a path rule that scopes
// such a command refuses the captured line instead of running it
// unguarded.
const SUBTREE_READ_FLAGS: Record<string, [string, string[]]> = {
  tar: ['c', ['create']],
  zip: ['r', ['recurse-paths']],
  cp: ['rR', ['recursive']],
}

// Whether a command's traversal enters descendant mounts.
export function walksMounts(name: string, words: readonly (string | PathSpec)[]): boolean {
  if (WALK_COMMANDS.has(name)) return true
  const spec = WALK_FLAGS[name]
  return spec !== undefined && hasOption(words, spec[0], spec[1])
}

// Whether a command reads below the paths its words name.
export function readsSubtrees(name: string, words: readonly (string | PathSpec)[]): boolean {
  if (walksMounts(name, words)) return true
  const spec = SUBTREE_READ_FLAGS[name]
  return spec !== undefined && hasOption(words, spec[0], spec[1])
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
// target where GNU answers "File exists".
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
])

// Whether a command resolves its operand's final component itself. The
// directory prefix is resolved for every command, so this is only about
// the last one: open(2) semantics (true) against lstat(2) (false). A
// trailing slash overrides a false per operand, which is `followPaths`'
// job because the slash is a property of the operand rather than of the
// command.
export function followsLastComponent(name: string, words: readonly (string | PathSpec)[]): boolean {
  if (reportsLink(name, words) || SELF_RESOLVING.has(name)) return false
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
