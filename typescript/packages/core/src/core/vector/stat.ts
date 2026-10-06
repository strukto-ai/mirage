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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import type { ReaddirFn } from '../hierarchy/probe.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat as hierarchyStat, type StatHook } from '../hierarchy/stat.ts'
import { tableOf } from './scope.ts'
import type { VectorTree } from './types.ts'

type ReadFn<A> = (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<Uint8Array>

function nameOf(spec: PathSpec): string {
  const last = rstripSlash(spec.virtual).split('/').pop()
  return last === undefined || last === '' ? '/' : last
}

/** Build a store's stat: a group proves its table, a row its bytes. */
export function makeStat<A extends Accessor>(
  tree: VectorTree<A>,
  readdir: ReaddirFn<A>,
  read: ReadFn<A>,
): (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<FileStat> {
  async function tableGuard(accessor: A, match: ScopeMatch, virtual: string): Promise<void> {
    const table = tableOf(tree.pinned(accessor), match)
    if (!(await tree.tableExists(accessor, table))) throw enoent(virtual)
  }
  async function statRow(
    accessor: A,
    match: ScopeMatch,
    path: PathSpec,
    index?: IndexCacheStore,
  ): Promise<FileStat> {
    await tableGuard(accessor, match, path.virtual)
    // The row-dir readdir seeds exact rendered sizes; an unsized entry or a
    // cold index falls back to rendering the row, so the size is exact
    // either way.
    const lookup = index !== undefined ? await index.get(rstripSlash(path.virtual)) : undefined
    const size = lookup?.entry?.size ?? (await read(accessor, path, index)).length
    return new FileStat({
      name: nameOf(path),
      size,
      type: FileType.FILE,
      content: match.scope?.filetype ?? null,
    })
  }
  const overrides: Record<string, StatHook<A>> = {}
  for (const kind of Object.keys(tree.readers)) overrides[kind] = statRow
  const statFor = perAccessor((accessor: A) =>
    hierarchyStat(tree.detect(accessor), readdir, { guards: { group: tableGuard }, overrides }),
  )
  return (accessor, path, index) => statFor(accessor)(accessor, path, index)
}
