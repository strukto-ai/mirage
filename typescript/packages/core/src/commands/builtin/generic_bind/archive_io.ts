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

import type { Accessor } from '../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { walkFind } from '../../../core/generic/find.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import type { WalkFn } from '../generic/archive/walk.ts'
import type { CommandIO } from './adapter.ts'

/**
 * The subtree listing tar and zip both walk with.
 *
 * Reuses find's walk so an archiver classifies an entry exactly the way find
 * does (through stat, never by name). The two calls a directory operand makes
 * share one readdir cache, so the second is answered from the index instead of
 * the backend.
 *
 * walkFind stands in for a backend's native find op, so it answers in
 * mount-relative keys; both archivers name members from virtual paths, so they
 * are lifted back here the way findGeneric lifts them.
 */
export function walkOf(
  ops: CommandIO,
  accessor: Accessor,
  index: IndexCacheStore | undefined,
): WalkFn {
  return async (p, findType) => {
    const prefix = mountPrefixOf(p.virtual, p.resourcePath)
    const keys = await walkFind(
      p,
      {
        readdir: (spec, i) => ops.readdir(accessor, spec, i),
        stat: (spec, i) => ops.stat(accessor, spec, i),
      },
      { type: findType },
      index,
    )
    if (prefix === '') return keys
    return keys.map((key) => (key === '/' ? prefix : prefix + key))
  }
}
