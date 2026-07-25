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
import { mvGeneric, parseMvFlags } from '../../generic/mv.ts'
import type { Builder } from '../adapter.ts'
import { overlayableStat } from './cp.ts'

export const MV_BUILDER: Builder = {
  name: 'mv',
  write: true,
  fn: (ops, accessor, paths, _texts, opts) => {
    const { rename } = ops
    if (rename === undefined) {
      throw new Error('mv: backend provides no rename op')
    }
    const idx = opts.index ?? undefined
    const parsed = parseMvFlags(opts.flags)
    return mvGeneric(
      paths,
      overlayableStat(ops, accessor, idx, opts.statOverlay),
      { rename: (src: PathSpec, target: PathSpec) => rename(accessor, src, target) },
      parsed,
      idx,
      undefined,
      (p: PathSpec) => ops.readdir(accessor, p, idx),
    )
  },
}
