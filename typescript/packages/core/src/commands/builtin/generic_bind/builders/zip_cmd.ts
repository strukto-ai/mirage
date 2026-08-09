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

import type { FileStat, PathSpec } from '../../../../types.ts'
import { zipGeneric } from '../../generic/zip_cmd.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'
import { walkOf } from '../archive_io.ts'

export const ZIP_BUILDER: Builder = {
  name: 'zip',
  write: true,
  requirements: ['write'],
  fn: async (ops, accessor, paths, _texts, opts) => {
    const idx = opts.index ?? undefined
    const { write } = ops
    if (write === undefined) {
      throw new Error('zip: backend provides no write op')
    }
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    return zipGeneric(resolved, opts, {
      stream: (p) => ops.readStream(accessor, p, idx),
      write: (p, data) => write(accessor, p, data),
      stat: async (p: PathSpec): Promise<FileStat> => ops.stat(accessor, p, idx),
      walk: walkOf(ops, accessor, idx),
    })
  },
}
