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

import { ShellBuiltin } from '../../shell/types.ts'
import type { PathSpec } from '../../types.ts'

// Bash builtins the parser accepts but the executor cannot honor; they
// still route to the shell layer so the error names a capability gap.
export const UNSUPPORTED_BUILTINS: ReadonlySet<string> = new Set([
  'bg',
  'disown',
  'exec',
  'complete',
  'compgen',
  'ulimit',
])

export const NAMESPACE_COMMANDS: ReadonlySet<string> = new Set(['ln', 'readlink'])

// bash reserved words that mirage's grammar implements. The parser, not
// the executor, consumes them, so they never reach route; `type` reports
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
export const JOB_BUILTINS: ReadonlySet<string> = new Set(['wait', 'fg', 'kill', 'jobs', 'ps'])

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
export const NO_FOLLOW_COMMANDS: ReadonlySet<string> = new Set([
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
export function reportsLink(name: string, words: readonly (string | PathSpec)[]): boolean {
  if (dereferences(name, words)) return false
  const spec = NO_FOLLOW_FLAGS[name]
  return spec !== undefined && hasOption(words, spec[0], spec[1])
}

export const SHELL_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(ShellBuiltin),
  ...UNSUPPORTED_BUILTINS,
])
