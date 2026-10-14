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

import { PathSpec } from '../../../../types.ts'
import { posixNormpath } from '../../../../utils/path.ts'
import { CD_OPTIONS } from './constants.ts'

export type DirArgs = (string | PathSpec)[]

export interface ModeOptions {
  operands: DirArgs
  bad: string | null
  physical: boolean
}

// Split leading -L/-P option flags (clusters like -LP, and a `--`
// terminator) from the operands. Shared by `cd` (which also takes -e -@)
// and `pwd`, so the last-wins rule -- `pwd -L -P` is physical, `pwd -P
// -L` logical -- has one implementation. A bare `-` is an operand (`cd`'s
// OLDPWD shorthand), not an option. `bad` is the first unknown character.
export function splitModeOptions(
  args: DirArgs,
  letters: string = CD_OPTIONS,
  // The mode to assume when the line names neither, which is what
  // `set -P` changes for the whole session.
  fallback = false,
): ModeOptions {
  const operands: DirArgs = []
  let parsing = true
  let physical = fallback
  for (const arg of args) {
    const s = arg instanceof PathSpec ? arg.virtual : arg
    if (parsing) {
      if (s === '--') {
        parsing = false
        continue
      }
      if (s !== '-' && s.length >= 2 && s.startsWith('-')) {
        let bad: string | null = null
        for (const c of s.slice(1)) {
          if (!letters.includes(c)) {
            bad = c
            break
          }
        }
        if (bad !== null) return { operands, bad, physical }
        for (const c of s.slice(1)) {
          if (c === 'P') physical = true
          else if (c === 'L') physical = false
        }
        continue
      }
      parsing = false
    }
    operands.push(arg)
  }
  return { operands, bad: null, physical }
}

// Resolve a combined `cd` target following symlinks per mode. Logical (-L,
// default) simplifies `..` textually first, then follows links; physical (-P)
// follows links first so `..` acts on the target. The namespace's walk leaves
// no link in what it answers, so one walk settles either. `follow` is the
// session's link resolution, which throws CycleError on a loop (ELOOP).
// Mirrors Python's resolve_target.
export function resolveTarget(
  combined: string,
  follow: (path: string) => string,
  physical: boolean,
): string {
  return posixNormpath(follow(physical ? combined : posixNormpath(combined)))
}

// Join an operand to `cwd` WITHOUT simplifying `..`. resolvePath normalizes,
// which is what -L wants but destroys the only input -P has: bash resolves a
// link before applying the `..` after it, so `/link/..` is the link's parent
// under -L and the target's parent under -P. Collapsing the `..` first makes
// the two modes identical. resolveTarget normalizes for both modes, so
// nothing downstream sees the raw form.
export function joinPath(path: string, cwd: string): string {
  if (path.startsWith('/')) return path
  let end = cwd.length
  while (end > 0 && cwd[end - 1] === '/') end -= 1
  return `${cwd.slice(0, end)}/${path}`
}

// The operand as typed, which is what -P has to resolve. A relative operand
// arrives as a PathSpec whose `virtual` was already normalized against cwd
// (expand/classify/relative.ts), losing its `..` before cd is reached;
// `rawPath` keeps the spelling.
export function typedPath(val: string | PathSpec): string {
  if (typeof val === 'string') return val
  return val.rawPath || val.virtual
}
