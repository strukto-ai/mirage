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
import { resolveGlobOf } from '../generic_bind/index.ts'
import { GITHUB_IO } from './io.ts'
import { countScopeFiles, scopeRelativeKey, shouldUseSearch } from '../../../core/github/scope.ts'
import { narrowPaths } from '../../../core/github/search.ts'
import type { PathSpec } from '../../../types.ts'
import { isLiteralPattern, searchQuery } from '../grep_helper.ts'

const resolveGlob = resolveGlobOf(GITHUB_IO)

export interface NarrowResult {
  resolved: PathSpec[]
  fileCount: number
  usedSearch: boolean
}

// Resolve grep/rg scope paths, narrowing via GitHub code search. Narrows any
// recursive scope (repo root or subdirectory) on the default branch when a
// literal can be pushed down to code search and the scope is larger than
// SCOPE_WARN; otherwise expands the scope by glob.
//
// Push-down requires -w. GitHub code search matches whole words while grep
// matches substrings, so for a bare literal the search result is a strict
// subset of the grep matches: a file containing the literal only inside a
// longer word (quokka inside quokkabuild) never comes back and would be
// silently dropped from the scan. Under -w both sides mean the same thing,
// and any tokenizer disagreement can only over-fetch, which the local scan
// then filters. A regex narrowed on an extracted literal stays excluded
// even under -w, because the searched term is then only part of the match.
export async function narrowScope(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  pattern: string | null,
  fixedString: boolean,
  recursive: boolean,
  wholeWord: boolean,
  index?: IndexCacheStore,
): Promise<NarrowResult> {
  const first = paths[0]
  if (first === undefined) return { resolved: [], fileCount: 0, usedSearch: false }
  const key = scopeRelativeKey(first)
  const fileCount = countScopeFiles(accessor.tree, key)
  const query = pattern !== null ? searchQuery(pattern, fixedString) : null
  const useSearch =
    query !== null &&
    wholeWord &&
    pattern !== null &&
    isLiteralPattern(pattern, fixedString) &&
    shouldUseSearch(recursive, accessor.isDefaultBranch) &&
    fileCount > SCOPE_WARN
  if (useSearch) {
    const narrowed = await narrowPaths(accessor, query, paths)
    if (narrowed.length > 0) {
      return { resolved: narrowed, fileCount: narrowed.length, usedSearch: true }
    }
  }
  const resolved = await resolveGlob(accessor, paths, index ?? undefined)
  return { resolved, fileCount, usedSearch: false }
}
