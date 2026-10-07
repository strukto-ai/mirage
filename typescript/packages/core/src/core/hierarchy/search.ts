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

import { PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { grepSearchOptions } from '../../commands/builtin/grep_pushdown.ts'
import type { SearchQuery, SearchOp, SearchResult, StatOp } from '../../vfs/types.ts'

import type { Accessor } from '../../accessor/base.ts'
import { compilePattern } from '../../commands/builtin/grep_pattern.ts'
import { RegexSyntax } from '../../commands/builtin/types.ts'
import { byteView } from '../../shell/bytes.ts'
import { ROOT, type DetectFn, type ScopeMatch } from './scope.ts'

export type LineMatcher = (line: string) => boolean

/**
 * Whether the generic scan would select a line, for this request. A searcher
 * that has to decide a line itself (a candidate the service returned, or a
 * line it rendered) decides it with this, so what it prints is what grep over
 * the same file would print. grep's dialects match a line's byte view in the C
 * locale and its text under a UTF-8 one, as its scan does; ripgrep's match the
 * text. Mirrors
 * `query_matcher` in `mirage/core/hierarchy/search.py`.
 */
export function queryMatcher(query: SearchQuery): LineMatcher {
  const options = grepSearchOptions(query)
  const rust = options.syntax === RegexSyntax.RUST
  const utf8 = options.utf8
  const pattern = compilePattern(
    rust ? query.query : byteView(query.query, utf8),
    options.ignoreCase,
    options.fixedString,
    options.wholeWord,
    options.syntax,
    utf8,
  )
  if (rust) return (line) => pattern.test(line)
  return (line) => pattern.test(byteView(line, utf8))
}

export type Searcher<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  query: SearchQuery,
) => Promise<SearchResult[]>

/** Adapt scope-specific handlers; an unhandled scope requests a scan. */
export function makeSearchOp<A extends Accessor>(
  detect: DetectFn,
  searchers: Readonly<Record<string, Searcher<A>>>,
  stat?: StatOp<A>,
): SearchOp<A> {
  return async (accessor, path, query, index) => {
    const match = detect(path)
    const searcher = searchers[match.kind]
    if (searcher === undefined) return null
    if (stat !== undefined && match.kind !== ROOT) await stat(accessor, path, index)
    const prefix = mountPrefixOf(path.virtual, path.vfsPath).replace(/\/$/, '')
    return (await searcher(accessor, match, query)).map(([hit, text]) => [
      PathSpec.fromStrPath(`${prefix}/${hit.vfsPath.replace(/^\//, '')}`, hit.vfsPath),
      text,
    ])
  }
}
