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

import type { GitHubAccessor } from '../../../accessor/github.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { SCOPE_WARN } from '../../../core/github/constants.ts'
import { resolveGlob } from '../../../core/github/glob.ts'
import { countScopeFiles, scopeRelativeKey, shouldUseSearch } from '../../../core/github/scope.ts'
import { narrowPaths } from '../../../core/github/search.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { rebaseDisplay } from '../../../utils/path.ts'
import { formatRecords } from '../utils/output.ts'
import { classifyPattern, PatternType, searchQuery } from '../grep_helper.ts'

export interface NarrowResult {
  resolved: PathSpec[]
  fileCount: number
  usedSearch: boolean
}

// Resolve grep/rg scope paths, narrowing via GitHub code search. Narrows any
// recursive scope (repo root or subdirectory) on the default branch when a
// literal can be pushed down to code search and the scope is larger than
// SCOPE_WARN; otherwise expands the scope by glob. Regex patterns narrow on an
// extracted required literal and stay exact because the caller still scans the
// regex over the narrowed files.
export async function narrowScope(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  pattern: string | null,
  fixedString: boolean,
  recursive: boolean,
  index?: IndexCacheStore,
): Promise<NarrowResult> {
  const first = paths[0]
  if (first === undefined) return { resolved: [], fileCount: 0, usedSearch: false }
  const key = scopeRelativeKey(first)
  const fileCount = countScopeFiles(accessor.tree, key)
  const query = pattern !== null ? searchQuery(pattern, fixedString) : null
  const useSearch =
    query !== null && shouldUseSearch(recursive, accessor.isDefaultBranch) && fileCount > SCOPE_WARN
  if (useSearch) {
    const narrowed = await narrowPaths(accessor, query, paths)
    if (narrowed.length > 0) {
      return { resolved: narrowed, fileCount: narrowed.length, usedSearch: true }
    }
  }
  const resolved = await resolveGlob(accessor, paths, index ?? undefined)
  return { resolved, fileCount, usedSearch: false }
}

// Emit the narrowed file list for a plain literal -l without reading. When
// code search has already narrowed the scope to the files containing a fully
// literal pattern, those files are exactly the answer to -l
// (files-with-matches), so the content fetches the generic command would do
// can be skipped entirely. Returns null whenever the short-circuit is unsafe
// (no -l, a non-literal pattern, or a flag that changes which lines match) so
// the caller falls back to the generic scan. pathPredicate reproduces any file
// filtering the generic command applies (rg's hidden/--type/--glob rules).
export function filesOnlyShortcircuit(
  flags: Record<string, string | boolean | string[]>,
  pattern: string | null,
  resolved: PathSpec[],
  scope: PathSpec,
  pathPredicate?: (p: string) => boolean,
): [ByteSource, IOResult] | null {
  const filesOnly = flags.args_l === true || flags.l === true
  if (!filesOnly || pattern === null) return null
  if (
    flags.i === true ||
    flags.w === true ||
    flags.v === true ||
    flags.c === true ||
    flags.o === true
  ) {
    return null
  }
  const fixed = flags.F === true
  const pt = classifyPattern(pattern, fixed)
  const fullyLiteral =
    fixed || pt === PatternType.EXACT || (pt === PatternType.SIMPLE && !pattern.includes('.'))
  if (!fullyLiteral) return null
  const hits = resolved
    .filter((p) => pathPredicate === undefined || pathPredicate(p.virtual))
    .map((p) => p.virtual)
  if (hits.length === 0) return [new Uint8Array(), new IOResult({ exitCode: 1 })]
  const displays = rebaseDisplay(hits, scope.virtual, scope.display)
  return [formatRecords([...displays].sort()), new IOResult()]
}
