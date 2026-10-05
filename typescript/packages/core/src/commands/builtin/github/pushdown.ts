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
import { IO } from './io.ts'
import {
  countScopeFiles,
  isDirectoryKey,
  scopeRelativeKey,
  searchSafe,
  shouldUseSearch,
} from '../../../core/github/pushdown.ts'
import { ensureTree } from '../../../core/github/tree.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { narrowPaths } from '../../../core/github/search.ts'
import type { PathSpec } from '../../../types.ts'
import { textCandidates, wholeWordLiteral } from '../grep_pushdown.ts'

const resolveGlob = resolveGlobOf(IO)

export interface NarrowResult {
  resolved: PathSpec[]
  fileCount: number
  usedSearch: boolean
}

// The refusal for a scope too large to scan without a narrowing. Push-down
// needs -w (see narrowScope), so without it the remedy is -w; with it, code
// search ran and its answer could not be trusted as the whole set, so only a
// narrower path is left.
export function scopeRefusal(command: string, fileCount: number, wholeWord: boolean): string {
  if (wholeWord) {
    return `${command}: ${String(fileCount)} files in scope and code search could not narrow them; narrow the path\n`
  }
  return `${command}: ${String(fileCount)} files in scope, narrow the path, or use -w to enable code search\n`
}

// Resolve grep/rg scope paths, narrowing via GitHub code search. Narrows any
// recursive scope (repo root or subdirectory) on the default branch when a
// whole-word literal can be pushed down to code search (wholeWordLiteral)
// and the scope is larger than SCOPE_WARN; otherwise expands the scope by
// glob. Code search is trusted only where it can answer for the whole scope:
// never over a truncated tree, which cannot list every file the search
// skips; only over directory operands, since a full scan reads a file named
// on the line whatever its extension; only for a literal the search grammar
// reads as plain terms (searchSafe); and only for an answer that is the
// whole set (narrowPaths). Binary-extension candidates are dropped from the
// narrowed set because the recursive walk it replaces skips them, so a
// narrowed set may be empty, which callers must not treat as a stdin run.
export async function narrowScope(
  accessor: GitHubAccessor,
  paths: PathSpec[],
  pattern: string | null,
  fixedString: boolean,
  recursive: boolean,
  wholeWord: boolean,
  index?: IndexCacheStore,
  exactFileSet = false,
): Promise<NarrowResult> {
  const first = paths[0]
  if (first === undefined) return { resolved: [], fileCount: 0, usedSearch: false }
  const key = scopeRelativeKey(first)
  await ensureTree(accessor, index, mountPrefixOf(first.virtual, first.vfsPath))
  const fileCount = countScopeFiles(accessor.tree, key)
  const query = wholeWordLiteral(pattern, fixedString, wholeWord)
  const useSearch =
    query !== null &&
    !exactFileSet &&
    fileCount > SCOPE_WARN &&
    !accessor.truncated &&
    paths.every((p) => isDirectoryKey(accessor.tree, scopeRelativeKey(p))) &&
    searchSafe(query) &&
    shouldUseSearch(recursive, accessor.isDefaultBranch)
  if (useSearch) {
    const narrowed = await narrowPaths(accessor, query, paths)
    if (narrowed !== null && narrowed.length > 0) {
      const kept = textCandidates(narrowed)
      return { resolved: kept, fileCount: kept.length, usedSearch: true }
    }
  }
  const resolved = await resolveGlob(accessor, paths, index ?? undefined)
  return { resolved, fileCount, usedSearch: false }
}
