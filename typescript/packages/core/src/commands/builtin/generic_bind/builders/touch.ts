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

import { IOResult } from '../../../../io/types.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

const ENC = new TextEncoder()

export const TOUCH_BUILDER: Builder = {
  name: 'touch',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    if (paths.length === 0) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('touch: missing operand\n') })]
    }
    const idx = opts.index ?? undefined
    const { write, exists } = ops
    if (write === undefined || exists === undefined) {
      throw new Error('touch: backend provides no write op')
    }
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    const createOnly = opts.flags.c === true
    for (const p of resolved) {
      if (createOnly) continue
      if (!(await exists(accessor, p))) {
        await write(accessor, p, new Uint8Array(0))
      }
    }
    return [null, new IOResult()]
  },
}
