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

import { fnmatch } from '../../utils/fnmatch.ts'
import type { FlagView } from '../spec/flag_view.ts'

/**
 * GNU's file-selection flags, threaded as one value.
 *
 * `fileGlobs` holds the --include/--exclude rules in command-line
 * order (the order decides ties, see `fileAdmitted`), `excludeDir`
 * prunes directories from the -r walk, and `text` (-a) lets the walk
 * read the extensions it would otherwise skip as binary. The empty
 * value admits everything, which is what every caller without the
 * flags passes.
 */
/** One --include/--exclude rule: a basename glob and its verdict. */
export interface FileGlob {
  glob: string
  admit: boolean
}

export interface WalkFilters {
  fileGlobs: readonly FileGlob[]
  excludeDir: readonly string[]
  text: boolean
}

/**
 * The --include/--exclude rules a line typed, in line order, an
 * --exclude-from's globs (read by the executor) where it stood.
 *
 * The bag lists each dest's values in occurrence order and the dests
 * themselves in first-typed order, so the rebuilt list is exact unless
 * a line alternates the two kinds three or more times (`--include a
 * --exclude b --include c`), where each kind's rules stay grouped at
 * its first position. Deliberate approximation: the bag is the only
 * channel a generic reads, and it carries no per-occurrence positions
 * across two dests.
 */
export function parseFileGlobs(fl: FlagView): readonly FileGlob[] {
  const rules: FileGlob[] = []
  for (const name of fl.typedOrder('include', 'exclude', 'exclude_from')) {
    const admit = name === 'include'
    for (const glob of fl.asList(name)) rules.push({ glob, admit })
  }
  return rules
}

/**
 * GNU's --include/--exclude gate for one candidate file.
 *
 * Globs match the base name with fnmatch wildcards, case sensitively (a
 * glob carrying a slash therefore matches nothing, which is what GNU
 * 3.11 answers too). The rules resolve in command-line order: the last
 * matching rule decides, and a file matching none is admitted only when the
 * first rule is an exclude (both pinned against GNU 3.11, where
 * `--include='*.txt' --exclude='*.txt'` skips a .txt file and the reversed
 * order searches it). Applies to command-line files exactly as to walked
 * ones, which is pinned GNU behavior: an explicit operand --include passes
 * over is silently no match, not an error.
 */
export function fileAdmitted(path: string, filters: WalkFilters): boolean {
  const rules = filters.fileGlobs
  const first = rules[0]
  if (first === undefined) return true
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  let verdict = !first.admit
  for (const rule of rules) {
    if (fnmatch(base, rule.glob)) verdict = rule.admit
  }
  return verdict
}

/** Whether the -r walk may descend into this directory. */
export function dirAdmitted(path: string, filters: WalkFilters): boolean {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return !filters.excludeDir.some((glob) => fnmatch(base, glob))
}
