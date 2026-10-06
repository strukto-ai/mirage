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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec, StatFn } from '../../types.ts'
import { eisdir, enoent } from '../../errors/fs.ts'
import { sliceWindow } from '../../utils/ranges.ts'
import { assertParent } from './probe.ts'
import { ROOT, type DetectFn, type ScopeMatch } from './scope.ts'

export type Reader<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
) => Promise<Uint8Array>

export interface ReadWindow {
  limit?: number | null
  offset?: number | null
}

export type WindowedReader<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  window: ReadWindow,
) => Promise<Uint8Array>

export interface HierarchyReadOptions<A extends Accessor> {
  /**
   * Readers for kinds whose content is windowed at the source (postgres rows
   * take a row limit/offset the backend pushes into the query); they receive
   * the caller's window, which every plain reader ignores, matching a
   * filesystem read that has no row notion.
   */
  windowed?: Readonly<Record<string, WindowedReader<A>>>
  /**
   * The backend's stat. Given, every read first proves the file's parent
   * directory exists the way stat proves it (`assertParent`), so a container
   * the listing refuses reads as absent exactly as `ls` and `stat` report it.
   * A backend whose readers address the API by the ids in the path passes it:
   * without it, `cat` of a board outside `boardIds` fetched that board by its
   * id. The file itself stays the reader's to prove, since a bounded listing
   * need not name every file that exists.
   */
  stat?: StatFn<[accessor: A, path: PathSpec, index?: IndexCacheStore]>
}

/**
 * Build a hierarchy read: classify, dispatch, refuse the rest.
 *
 * Readers own their fetches, guards and rendering; the kit owns the
 * classification and the ENOENT funnel for every non-file shape. `readers`
 * holds one reader per leaf kind. Mirrors `make_read` in
 * `mirage/core/hierarchy/read.py`.
 */
export function makeRead<A extends Accessor>(
  detect: DetectFn,
  readers: Readonly<Record<string, Reader<A>>>,
  options: HierarchyReadOptions<A> = {},
): (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
  window?: ReadWindow,
) => Promise<Uint8Array> {
  const windowed = options.windowed ?? {}
  const stat = options.stat
  return async function read(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
    window: ReadWindow = {},
  ): Promise<Uint8Array> {
    const match = detect(path)
    const windowReader = windowed[match.kind]
    const reader = readers[match.kind]
    if (stat !== undefined && (windowReader !== undefined || reader !== undefined)) {
      await assertParent(stat, accessor, path, index)
    }
    if (windowReader !== undefined) return windowReader(accessor, match, path, index, window)
    if (reader === undefined) {
      // A directory that exists by construction (the root, or a
      // probed=false scope) read as a file is EISDIR. Everything else is
      // reported absent: a matched shape alone is no proof the node
      // exists, and GNU says "No such file" for a missing name, "Is a
      // directory" only for a real one.
      if (
        match.kind === ROOT ||
        (match.scope !== null && !match.scope.leaf && !match.scope.probed)
      ) {
        throw eisdir(path)
      }
      throw enoent(path)
    }
    return reader(accessor, match, path, index)
  }
}

export type RangedReader<A extends Accessor> = (
  accessor: A,
  match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  offset: number,
  size: number | null,
) => Promise<Uint8Array>

/**
 * Build a byte-ranged read over a hierarchy read.
 *
 * A rendered file has no remote range to ask for — its bytes do not exist
 * until the read renders them — so the window is sliced after the fact. A
 * stored blob does (discord and slack attachments serve HTTP range
 * requests), and downloading the whole file to keep a slice would defeat the
 * ranged read; those kinds name a ranged reader in `ranged` and push the
 * byte window to the source.
 */
export function makeReadRange<A extends Accessor>(
  detect: DetectFn,
  read: (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<Uint8Array>,
  ranged: Readonly<Record<string, RangedReader<A>>>,
): (
  accessor: A,
  path: PathSpec,
  index?: IndexCacheStore,
  options?: { offset?: number; size?: number },
) => Promise<Uint8Array> {
  return async function readRange(
    accessor: A,
    path: PathSpec,
    index?: IndexCacheStore,
    options?: { offset?: number; size?: number },
  ): Promise<Uint8Array> {
    const offset = options?.offset ?? 0
    const size = options?.size ?? null
    const match = detect(path)
    const fn = ranged[match.kind]
    if (fn !== undefined) return fn(accessor, match, path, index, offset, size)
    return sliceWindow(await read(accessor, path, index), offset, size)
  }
}
