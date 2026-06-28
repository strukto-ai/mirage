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

import { headerAggregate } from '../../aggregators.ts'
import { headGeneric, headProvisionGeneric } from '../../generic/head.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const HEAD_BUILDER: Builder = {
  name: 'head',
  read: true,
  aggregate: headerAggregate,
  fn: async (ops, accessor, paths, texts, opts) => {
    const idx = opts.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    return headGeneric(
      resolved,
      texts,
      opts,
      (p) => ops.stat(accessor, p, idx),
      (p) => ops.readStream(accessor, p, idx),
    )
  },
  provision:
    (stat) =>
    (accessor, paths, texts, opts) =>
      headProvisionGeneric(paths, texts, opts, (p) => stat(accessor, p)),
}
