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

import { type FileStat, FileType, type PathSpec } from '../../../../types.ts'
import { tarGeneric } from '../../generic/tar.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'
import { walkOf } from '../archive_io.ts'

export const TAR_BUILDER: Builder = {
  name: 'tar',
  write: true,
  requirements: ['write', 'mkdir'],
  fn: async (ops, accessor, paths, _texts, opts) => {
    const idx = opts.index ?? undefined
    const { write, mkdir } = ops
    if (write === undefined || mkdir === undefined) {
      throw new Error('tar: backend provides no write op')
    }
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    const stat = async (p: PathSpec): Promise<FileStat> => ops.stat(accessor, p, idx)
    return tarGeneric(resolved, opts, {
      stream: (p) => ops.readStream(accessor, p, idx),
      write: (p, data) => write(accessor, p, data),
      mkdir: (p, parents) => mkdir(accessor, p, parents),
      stat,
      walk: walkOf(ops, accessor, idx),
      // Two channels, because a stat miss alone is not absence: on a
      // prefix store a directory is the set of keys under it and
      // nothing answers stat for it, so a readdir that returns anything
      // is the second and deciding opinion.
      isDir: async (p) => {
        try {
          return (await stat(p)).type === FileType.DIRECTORY
        } catch {
          // Not an object of its own; ask the listing instead.
        }
        try {
          return (await ops.readdir(accessor, p, idx)).length > 0
        } catch {
          return false
        }
      },
    })
  },
}
