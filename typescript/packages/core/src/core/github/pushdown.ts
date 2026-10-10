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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { PathSpec } from '../../types.ts'
import { CODE_SEARCH_SIZE_LIMIT } from './constants.ts'
import type { TreeEntry } from './tree_entry.ts'

export function scopeRelativeKey(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  let key = path.virtual
  if (prefix !== '' && key.startsWith(prefix)) {
    key = key.slice(prefix.length) || '/'
  }
  return key
}

// The file entries at or below a repo-relative scope key, in tree order:
// every blob for the repository root, the file itself for a file key. A
// sibling that merely shares the scope's spelling (srcx/ beside src/) is
// outside it. Tree keys are repo-relative without a leading slash, which is
// the space `key` is already in.
export function scopeBlobs(tree: Record<string, TreeEntry>, key: string): [string, TreeEntry][] {
  const norm = stripSlash(key)
  const prefix = `${norm}/`
  const out: [string, TreeEntry][] = []
  for (const [p, entry] of Object.entries(tree)) {
    if (entry.type !== 'blob') continue
    if (norm !== '' && p !== norm && !p.startsWith(prefix)) continue
    out.push([p, entry])
  }
  return out
}

export function countScopeFiles(tree: Record<string, TreeEntry>, key: string): number {
  return scopeBlobs(tree, key).length
}

const NARROWING = /[:"]|(?:^|[^A-Za-z0-9_])-|(?:^|[^A-Za-z0-9_])NOT(?:[^A-Za-z0-9_]|$)/
const WORD = /[A-Za-z0-9_]/

// Whether a literal can be sent to code search without rescoping it. The
// literal goes into the query verbatim, so any part of it the search grammar
// reads as syntax narrows the answer to less than the files that hold it.
// Measured against api.github.com: a `name:` word is a qualifier, a quote
// opens a phrase, a word-leading `-` negates and `NOT` is an operator;
// lowercase `not` and `OR` are plain terms, and parentheses are refused with
// a 422, which already falls back. Word characters are ASCII so both hosts
// gate the same literals, and a literal holding none of them would send a
// query that is only its scope.
export function searchSafe(query: string): boolean {
  return WORD.test(query) && !NARROWING.test(query)
}

// The files under a scope that code search never indexes: at or over
// CODE_SEARCH_SIZE_LIMIT, or of a size the tree did not report, since
// nothing vouches for those either. Sorted repo-relative keys.
export function unsearchableKeys(tree: Record<string, TreeEntry>, key: string): string[] {
  const out: string[] = []
  for (const [p, entry] of scopeBlobs(tree, key)) {
    if (entry.size === null || entry.size >= CODE_SEARCH_SIZE_LIMIT) out.push(p)
  }
  return out.sort(compareCodePoints)
}
