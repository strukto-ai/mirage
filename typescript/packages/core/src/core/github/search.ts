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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GitHubAccessor } from '../../accessor/github.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { lstripSlash, stripSlash } from '../../utils/slash.ts'
import { ScanReason } from '../../vfs/types.ts'
import { type GitHubTransport, type GitHubCodeSearch, searchCode } from './client.ts'
import { SCOPE_ERROR, SCOPE_WARN } from './constants.ts'
import { countScopeFiles, scopeRelativeKey, searchSafe, unsearchableKeys } from './pushdown.ts'
import { ensureTree } from './tree.ts'

// Use GitHub code search to narrow grep/rg scopes to candidate files.
// Returns null whenever the narrowed set cannot be trusted as a superset of
// what a full scan would read (a search failure, or an answer that is not
// the whole set), so the caller falls back to the full scan. A trusted set
// also carries every file code search never indexes, which no answer can
// name; those come from the accessor's tree.
export async function narrowPaths(
  accessor: GitHubAccessor,
  query: string,
  paths: readonly PathSpec[],
): Promise<PathSpec[] | null> {
  const first = paths[0]
  if (first === undefined) return []
  const mountPrefix = mountPrefixOf(first.virtual, first.vfsPath)
  const narrowed: string[] = []
  for (const p of paths) {
    const key = scopeRelativeKey(p)
    const pathFilter = stripSlash(key)
    let answer: GitHubCodeSearch
    try {
      answer = await searchCode(
        accessor.transport,
        accessor.owner,
        accessor.repo,
        query,
        pathFilter === '' ? undefined : pathFilter,
      )
    } catch (err) {
      console.warn(`github code search failed (${String(err)}); falling back to per-file scan`)
      return null
    }
    if (answer.truncated) return null
    const scopePrefix = pathFilter === '' ? '' : `${pathFilter}/`
    const hits = answer.results
      .map((r) => r.path)
      .filter((path) => path === pathFilter || path.startsWith(scopePrefix))
    const seen = new Set(hits)
    narrowed.push(...hits)
    for (const k of unsearchableKeys(accessor.tree, key)) if (!seen.has(k)) narrowed.push(k)
  }
  return narrowed.map((n) => {
    const virtual = `${mountPrefix}/${lstripSlash(n)}`
    return new PathSpec({
      virtual,
      directory: '',
      vfsPath: mountKey(virtual, mountPrefix),
      resolved: true,
    })
  })
}

async function scopeFiles(
  accessor: GitHubAccessor,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<number> {
  const first = under[0]
  if (first === undefined) return 0
  await ensureTree(accessor, index, mountPrefixOf(first.virtual, first.vfsPath))
  let count = 0
  for (const p of under) count += countScopeFiles(accessor.tree, scopeRelativeKey(p))
  return count
}

/**
 * The files under `under` that may hold the whole word `text`.
 *
 * Code search answers only where it can vouch for the whole scope: more
 * than `SCOPE_WARN` files (fewer are cheaper to read), a tree the API did
 * not truncate, the default branch (the only one code search indexes), a
 * word the search grammar reads as plain terms (`searchSafe`), and an
 * answer that is the whole set (`narrowPaths`, which adds back every file
 * the search never indexes). An empty answer is not trusted either: the
 * index trails a push.
 */
export async function filesContaining(
  accessor: GitHubAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  if (
    accessor.truncated ||
    !searchSafe(text) ||
    (await scopeFiles(accessor, under, index)) <= SCOPE_WARN ||
    !accessor.isDefaultBranch
  ) {
    return null
  }
  const narrowed = await narrowPaths(accessor, text, under)
  return narrowed !== null && narrowed.length > 0 ? narrowed : null
}

/**
 * Refuse a scan of more than `SCOPE_ERROR` files.
 *
 * Each file is one blob request, so a scope that large is refused rather
 * than read. The remedy names `-w` when no search answered or the pattern
 * held no plain text on the default branch, the only one code search
 * indexes: there a whole word lets it narrow the scope.
 */
export async function beforeFullScan(
  accessor: GitHubAccessor,
  under: readonly PathSpec[],
  reason: ScanReason,
  index?: IndexCacheStore,
): Promise<void> {
  const count = await scopeFiles(accessor, under, index)
  if (count <= SCOPE_ERROR) return
  if (
    (reason === ScanReason.UNANSWERED || reason === ScanReason.NO_TEXT) &&
    accessor.isDefaultBranch
  ) {
    throw new Error(
      `${String(count)} files in scope and code search could not narrow them; ` +
        'narrow the path, or search a whole word with -w',
    )
  }
  throw new Error(`${String(count)} files in scope, narrow the path`)
}

/** Fetch a bounded REST search, following the server's pagination. */
export async function search(
  transport: GitHubTransport,
  kind: string,
  query: string,
  limit: number,
  sort?: string,
  order?: string,
): Promise<unknown[]> {
  const params: Record<string, string> = {
    q: query,
    per_page: String(Math.min(limit, 100)),
    page: '1',
  }
  if (sort !== undefined) params.sort = sort
  if (order !== undefined) params.order = order
  const rows: unknown[] = []
  for (let page = 1; rows.length < limit; page += 1) {
    params.page = String(page)
    const headers = {
      Accept:
        kind === 'code'
          ? 'application/vnd.github.text-match+json'
          : 'application/vnd.github.v3+json',
    }
    const response =
      transport.requestWithResponse === undefined
        ? {
            data: await transport.request('GET', `/search/${kind}`, undefined, params, headers),
            headers: {} as Record<string, string>,
          }
        : await transport.requestWithResponse('GET', `/search/${kind}`, undefined, params, headers)
    const body = response.data as { items?: unknown[] }
    const items = body.items ?? []
    if (!Array.isArray(items)) throw new Error('invalid search response: items must be an array')
    rows.push(...items.slice(0, limit - rows.length))
    if (items.length === 0 || !(response.headers.link ?? '').includes('rel="next"')) break
  }
  return rows
}
