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

// ShellBuiltin subset handled through the job table in the executor.
export const JOB_BUILTINS: ReadonlySet<string> = new Set(['wait', 'fg', 'kill', 'jobs', 'ps'])

// Commands with lstat semantics: they act on the symlink entry itself,
// so dispatch must not rewrite their operands through the link table.
// `stat`, `file` and `du` are here because GNU lstats for all three,
// but each takes -L to dereference after all, which `dereferences`
// reads back out of the command line.
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
])

// Per-command flags that turn a no-follow command back into a
// following one, GNU's -L / --dereference.
const DEREFERENCE_FLAGS: Record<string, [string, string[]]> = {
  stat: ['L', ['dereference']],
  file: ['L', ['dereference']],
  du: ['L', ['dereference']],
  ls: ['L', ['dereference']],
  // find's -P (no follow) is the default; -H dereferences the start
  // point only and -L dereferences everything, so both follow the
  // operand.
  find: ['LH', []],
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

// Whether a no-follow command was asked to dereference after all.
export function dereferences(name: string, words: readonly (string | PathSpec)[]): boolean {
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
