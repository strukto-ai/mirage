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

import type { PathSpec } from '../../../../types.ts'
import { statGeneric } from '../../generic/stat.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const STAT_BUILDER: Builder = {
  name: 'stat',
  fn: async (ops, accessor, paths, _texts, opts) => {
    const idx = opts.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    const overlay = opts.statOverlay
    // stat, like ls -l, renders backend stat rows that never see the
    // namespace attr overlay (chmod/chown/touch) or the default owner;
    // merge it in so stat -c and ls -l agree.
    const stat =
      overlay !== undefined
        ? async (p: PathSpec) => overlay(p.virtual, await ops.stat(accessor, p, idx))
        : (p: PathSpec) => ops.stat(accessor, p, idx)
    return statGeneric(resolved, opts, stat)
  },
}
