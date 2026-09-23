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
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { readBytesOp, statOp } from '../../generic/crossmount/utils.ts'
import { tarGeneric } from '../../generic/tar.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'
import { isDirOf, walkOf } from '../archive_io.ts'

export const TAR_BUILDER: Builder = {
  name: 'tar',
  write: true,
  requirements: ['write', 'mkdir'],
  fn: async (ops, accessor, paths, texts, opts) => {
    const idx = opts.index ?? undefined
    const { write, mkdir } = ops
    if (write === undefined || mkdir === undefined) {
      throw new Error('tar: backend provides no write op')
    }
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    const stat = async (p: PathSpec): Promise<FileStat> => ops.stat(accessor, p, idx)
    const dispatch = opts.dispatch
    const fl = new FlagView(opts.flags, specOf('tar'))
    if (dispatch !== undefined && !fl.asBool('c')) {
      // -t reads and -x writes wherever cwd or -C says, which need not
      // be this mount, so both run on dispatch-relayed doors and each
      // path routes to the mount that owns it. Only -c stays on the
      // accessor: its planner walks this mount's tree.
      const readBytes = readBytesOp(dispatch)
      async function* streamOf(p: PathSpec): AsyncIterable<Uint8Array> {
        yield await readBytes(p)
      }
      return tarGeneric(
        resolved,
        texts,
        opts,
        {
          stream: streamOf,
          write: async (p, data) => {
            await dispatch('write', p, [data])
          },
          mkdir: async (p) => {
            await dispatch('mkdir', p)
          },
          stat: statOp(dispatch),
          walk: walkOf(ops, accessor, idx),
          isDir: () => Promise.resolve(false),
        },
        true,
      )
    }
    return tarGeneric(resolved, texts, opts, {
      stream: (p) => ops.readStream(accessor, p, idx),
      write: (p, data) => write(accessor, p, data),
      mkdir: (p, parents) => mkdir(accessor, p, parents),
      stat,
      walk: walkOf(ops, accessor, idx),
      isDir: isDirOf(ops, accessor, idx),
    })
  },
}
