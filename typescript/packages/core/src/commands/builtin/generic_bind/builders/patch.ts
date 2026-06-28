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

import { patchGeneric } from '../../generic/patch.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const PATCH_BUILDER: Builder = {
  name: 'patch',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    const idx = opts.index ?? undefined
    const { write } = ops
    if (write === undefined) {
      throw new Error('patch: backend provides no write op')
    }
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    return patchGeneric(
      resolved,
      opts,
      (p) => ops.readStream(accessor, p, idx),
      (p, d) => write(accessor, p, d),
    )
  },
}
