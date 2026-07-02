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
import type { GitHubAccessor } from '../../accessor/github.ts'
import { LookupStatus } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { fetchDirTree } from './_client.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

function stripPrefix(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  return p
}

function normalizeKey(p: string): string {
  const trimmed = stripSlash(p)
  return trimmed === '' ? '/' : `/${trimmed}`
}

export async function readdir(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  if (index === undefined) {
    throw enoent(path.virtual)
  }
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const stripped = stripPrefix(path)
  const key = normalizeKey(stripped)

  const listing = await index.listDir(key)
  if (listing.entries !== undefined && listing.entries !== null) {
    return prefix !== '' && listing.entries.length > 0 && !listing.entries[0]?.startsWith(prefix)
      ? listing.entries.map((e) => prefix + e)
      : listing.entries
  }
  if (listing.status === LookupStatus.NOT_FOUND) {
    if (accessor.truncated) {
      return fallbackReaddir(accessor, key, index, prefix)
    }
    throw enoent(path)
  }
  return []
}

async function fallbackReaddir(
  accessor: GitHubAccessor,
  key: string,
  index: IndexCacheStore,
  prefix: string,
): Promise<string[]> {
  const parentSha = await resolveDirSha(accessor, key, index)
  if (parentSha === null) throw enoent(`${prefix}/${key}`)
  const entries = await fetchDirTree(accessor.transport, accessor.owner, accessor.repo, parentSha)
  const childKeys: string[] = []
  const childEntries: [string, IndexEntry][] = []
  for (const e of entries) {
    const childKey = `${key === '/' ? '' : key}/${e.path}`
    childKeys.push(childKey)
    childEntries.push([
      childKey,
      new IndexEntry({
        id: e.sha,
        name: e.path,
        vfsName: e.path,
        resourceType: e.type === 'tree' ? 'folder' : 'file',
        size: e.size ?? null,
      }),
    ])
  }
  childKeys.sort()
  await index.setDir(key, childEntries)
  return childKeys.map((k) => (prefix !== '' ? prefix + k : k))
}

async function resolveDirSha(
  accessor: GitHubAccessor,
  key: string,
  index: IndexCacheStore,
): Promise<string | null> {
  const result = await index.get(key)
  if (result.entry !== undefined && result.entry !== null) {
    return result.entry.id
  }
  const parts = stripSlash(key)
    .split('/')
    .filter((p) => p !== '')
  let currentSha = accessor.ref
  let currentPath = ''
  for (const part of parts) {
    const entries = await fetchDirTree(
      accessor.transport,
      accessor.owner,
      accessor.repo,
      currentSha,
    )
    const found = entries.find((e) => e.path === part)
    if (found === undefined) return null
    currentSha = found.sha
    currentPath += `/${part}`
    await index.put(
      currentPath,
      new IndexEntry({
        id: found.sha,
        name: part,
        vfsName: part,
        resourceType: found.type === 'tree' ? 'folder' : 'file',
        size: found.size ?? null,
      }),
    )
  }
  return currentSha
}
