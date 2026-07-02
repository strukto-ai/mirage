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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
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

export async function read(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const p = stripPrefix(path)
  if (index === undefined) throw enoent(path)
  const result = await index.get(indexKey(p))
  if (result.entry === undefined || result.entry === null) throw enoent(path)
  if (result.entry.resourceType === 'folder') throw eisdir(p)
  return fetchBlob(accessor.transport, accessor.owner, accessor.repo, result.entry.id)
}

export async function readBytes(accessor: GitHubAccessor, sha: string): Promise<Uint8Array> {
  return fetchBlob(accessor.transport, accessor.owner, accessor.repo, sha)
}

export async function* stream(
  accessor: GitHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const data = await read(accessor, path, index)
  yield data
}
