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

import type { IndexEntry } from '@struktoai/mirage-core/cache/index/config'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { record, startOp } from '@struktoai/mirage-core/observe/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { eisdir, enoent } from '@struktoai/mirage-core/utils/errors'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { ByteWindow } from '@struktoai/mirage-core/utils/ranges'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { hubBytes, resolveUrl } from './client.ts'
import { isDir, keyOf, lookup } from './lookup.ts'

export interface HfHubReadOptions {
  offset?: number
  size?: number
}

/**
 * The tree row for a path, or the error that says why there is none.
 *
 * Shared by every content read so a file, a directory and an absence are told
 * apart in exactly one place. It also means a read never reaches the network
 * for a path the listing already knows is absent.
 */
export async function resolveEntry(
  accessor: HfHubAccessor,
  pathSpec: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<IndexEntry> {
  const virtual = pathSpec.virtual
  const prefix = mountPrefixOf(pathSpec.virtual, pathSpec.resourcePath)
  const rel = pathSpec.mountPath.replace(/^\/+|\/+$/g, '')
  if (rel === '') throw eisdir(virtual)
  const found = await lookup(accessor, index, prefix, keyOf(prefix, rel))
  if (isDir(found)) throw eisdir(virtual)
  if (found.entry === null) throw enoent(virtual)
  return found.entry
}

export async function read(
  accessor: HfHubAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  options: HfHubReadOptions = {},
): Promise<Uint8Array> {
  await resolveEntry(accessor, path, index)
  const raw = path.mountPath
  const url = resolveUrl(
    accessor.endpoint,
    accessor.repoType,
    accessor.repoId,
    accessor.revision,
    accessor.repoPath(raw),
  )
  // `size: null` is the window's own spelling for "the rest of the file",
  // which is not the same as asking for no window at all.
  const hasWindow = (options.offset ?? 0) > 0 || options.size !== undefined
  const window: ByteWindow | undefined = hasWindow
    ? { offset: options.offset ?? 0, size: options.size ?? null }
    : undefined
  const timer = startOp()
  const data = await hubBytes(accessor.token, url, window)
  record('read', raw, accessor.resourceName, data.length, timer)
  return data
}
