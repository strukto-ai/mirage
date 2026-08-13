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

import { walkFind } from '../../../../core/generic/find.ts'
import { findGeneric } from '../../generic/find.ts'
import type { PathSpec } from '../../../../types.ts'
import { type Builder, overlaidStat, resolveGlobOf } from '../adapter.ts'

export const FIND_BUILDER: Builder = {
  name: 'find',
  fn: async (ops, accessor, paths, texts, opts) => {
    const idx = opts.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    const { find } = ops
    // Whether a directory start point holds nothing, for `-empty`. Asked
    // once, for the start point, and only when the expression mentions it.
    const dirEmpty = async (spec: PathSpec): Promise<boolean> =>
      (await ops.readdir(accessor, spec, idx)).length === 0
    if (find !== undefined) {
      // -mtime must see namespace times (touch results, observed
      // writes), so local backends post-filter through the overlay-
      // aware stat instead of pushing the window into the core.
      const stat =
        ops.local === true
          ? overlaidStat((spec) => ops.stat(accessor, spec, idx), opts.ns?.statOverlay)
          : undefined
      return findGeneric(
        resolved,
        texts,
        opts,
        (root, options) => find(accessor, root, options),
        stat,
        dirEmpty,
      )
    }
    // No backend find op: walk readdir/stat; the walk classifies entries
    // through stat (see walkFind).
    return findGeneric(
      resolved,
      texts,
      opts,
      (root, options) =>
        walkFind(
          root,
          {
            readdir: (spec, i) => ops.readdir(accessor, spec, i),
            // -mtime must see namespace times (touch results, observed
            // writes on mtime-less backends), same as ls.
            stat: async (spec, i) => {
              const st = await ops.stat(accessor, spec, i)
              const overlay = opts.ns?.statOverlay
              return overlay !== undefined ? overlay(spec.virtual, st) : st
            },
            // A namespace symlink is an entry `-empty` must count and no
            // backend readdir can see.
            links: opts.ns?.links ?? null,
          },
          options,
          idx,
        ),
      undefined,
      dirEmpty,
    )
  },
}
