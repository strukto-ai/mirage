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

import { type ByteSource, IOResult } from '../../../../io/types.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

const ENC = new TextEncoder()

export const LN_BUILDER: Builder = {
  name: 'ln',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    if (paths.length < 2) {
      return [
        null,
        new IOResult({ exitCode: 1, stderr: ENC.encode('ln: usage: ln [-s] [-f] source dest\n') }),
      ]
    }
    const idx = opts.index ?? undefined
    const { write, exists } = ops
    if (write === undefined || exists === undefined) {
      throw new Error('ln: backend provides no write op')
    }
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    const source = resolved[0]
    const dest = resolved[1]
    if (source === undefined || dest === undefined) return [null, new IOResult()]
    if (opts.flags.n === true && (await exists(accessor, dest))) {
      return [null, new IOResult()]
    }
    const data = await ops.readBytes(accessor, source, idx)
    await write(accessor, dest, data)
    const out: ByteSource | null =
      opts.flags.v === true ? ENC.encode(`'${source.original}' -> '${dest.original}'\n`) : null
    return [out, new IOResult({ writes: { [dest.stripPrefix]: data } })]
  },
}
