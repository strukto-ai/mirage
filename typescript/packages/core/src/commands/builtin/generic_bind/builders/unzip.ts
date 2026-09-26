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
import { readBytesOp, statOp } from '../../generic/crossmount/utils.ts'
import { unzipGeneric } from '../../generic/unzip.ts'
import { type Builder, requireOp, resolveGlobOf } from '../adapter.ts'

export const UNZIP_BUILDER: Builder = {
  name: 'unzip',
  write: true,
  fn: async (ops, accessor, paths, texts, opts) => {
    const idx = opts.index ?? undefined
    const write = requireOp(ops.write, 'write')
    const mkdir = requireOp(ops.mkdir, 'mkdir')
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    const dispatch = opts.dispatch
    if (dispatch !== undefined) {
      // Extraction writes wherever cwd or -d says, which need not be
      // this mount, so the doors are dispatch-relayed and each path
      // routes to the mount that owns it.
      const readBytes = readBytesOp(dispatch)
      async function* streamOf(p: PathSpec): AsyncIterable<Uint8Array> {
        yield await readBytes(p)
      }
      return unzipGeneric(
        resolved,
        texts,
        opts,
        streamOf,
        async (p, data) => {
          await dispatch('write', p, [data])
        },
        async (p) => {
          await dispatch('mkdir', p)
        },
        statOp(dispatch),
        true,
      )
    }
    return unzipGeneric(
      resolved,
      texts,
      opts,
      (p) => ops.readStream(accessor, p, idx),
      (p, d) => write(accessor, p, d),
      (p, parents) => mkdir(accessor, p, parents),
    )
  },
}
