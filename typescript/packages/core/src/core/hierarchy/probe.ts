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

import type { Accessor } from '../../accessor/base.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'

export type ReaddirFn<A extends Accessor> = (
  accessor: A,
  pathSpec: PathSpec,
  index?: IndexCacheStore,
) => Promise<string[]>

function basenameOf(entry: string): string {
  const trimmed = rstripSlash(entry)
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/**
 * Throw ENOENT unless the path appears in its parent's listing.
 *
 * Every path shape a fixed hierarchy serves is recognizable from the text
 * alone, but a recognizable shape is not evidence the entry exists. The
 * parent listing is index-cached, so validating costs one listing per
 * directory rather than one API call per stat.
 */
export async function assertListed<A extends Accessor>(
  readdir: ReaddirFn<A>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<void> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const virtual = rstripSlash(path.virtual)
  const parentVirtual = virtual.slice(0, virtual.lastIndexOf('/')) || '/'
  const entries = await readdir(
    accessor,
    new PathSpec({
      virtual: parentVirtual,
      directory: parentVirtual,
      resolved: false,
      vfsPath: mountKey(parentVirtual, prefix),
    }),
    index,
  )
  const names = new Set(entries.map(basenameOf))
  if (!names.has(basenameOf(path.vfsPath))) throw enoent(path)
}

/** Return the size the parent listing recorded for this path. */
export async function listedSize(
  index: IndexCacheStore | undefined,
  path: PathSpec,
): Promise<number | null> {
  if (index === undefined) return null
  // assertListed has just populated the parent directory, so any size the
  // listing computed is already in the index.
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const lookup = await index.get(`${prefix}/${path.vfsPath}`)
  return lookup.entry?.size ?? null
}

/**
 * Resolve the path's index entry, listing its parent when cold.
 *
 * Id-addressed backends can only turn a path into an id through the index,
 * so the entry is the proof of existence AND the id source; this wraps
 * `entryOrWarm` with the parent-readdir warm every such backend used to
 * spell by hand.
 */
export async function resolveEntry<A extends Accessor>(
  readdir: ReaddirFn<A>,
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<IndexEntry | null> {
  if (index === undefined) return null
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const key = stripSlash(path.vfsPath)
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'
  const parentVirtual = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
  const warm =
    parentVirtual !== virtualKey
      ? () =>
          readdir(
            accessor,
            new PathSpec({
              virtual: parentVirtual,
              directory: parentVirtual,
              resolved: false,
              vfsPath: mountKey(parentVirtual, prefix),
            }),
            index,
          )
      : null
  return entryOrWarm(index, virtualKey, warm)
}
