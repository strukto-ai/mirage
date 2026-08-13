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

import { LookupStatus } from '../../cache/index/config.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GitHubAccessor } from '../../accessor/github.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { refillIndex } from './tree.ts'
import { fetchBlob } from './_client.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

function eisdir(path: string): Error {
  const e = new Error(`EISDIR: ${path}`) as Error & { code: string }
  e.code = 'EISDIR'
  return e
}

function stripPrefix(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  return p
}

function indexKey(p: string): string {
  const trimmed = stripSlash(p)
  return trimmed === '' ? '/' : `/${trimmed}`
}

function parentKey(key: string): string {
  const cut = key.lastIndexOf('/')
  return cut <= 0 ? '/' : key.slice(0, cut)
}

export async function read(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const p = stripPrefix(path)
  if (index === undefined) throw enoent(path)
  const key = indexKey(p)
  // Freshness is tracked per directory, never per entry, so a blob's row
  // is exactly as fresh as its parent's listing and `get` can never report
  // staleness of its own. The parent is therefore the probe: after a write
  // invalidated the index the row survives carrying the *pre-write* blob
  // sha, and reading it back served the old bytes. A miss is not a probe
  // either -- against a live index it is a real absence, and refetching the
  // whole tree on every ENOENT costs a recursive-tree call per miss.
  if (!accessor.truncated) {
    const parent = await index.listDir(parentKey(key))
    if (parent.status === LookupStatus.EXPIRED) await refillIndex(accessor, index)
  }
  const result = await index.get(key)
  if (result.entry === undefined || result.entry === null) throw enoent(path)
  if (result.entry.resourceType === 'folder') throw eisdir(p)
  return fetchBlob(accessor.transport, accessor.owner, accessor.repo, result.entry.id)
}

export async function* stream(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const data = await read(accessor, path, index)
  yield data
}
