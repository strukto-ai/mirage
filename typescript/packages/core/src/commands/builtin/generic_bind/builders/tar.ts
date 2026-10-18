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
import { fileStreamOp, statOp } from '../../generic/crossmount/utils.ts'
import { tarGeneric } from '../../generic/tar/tar.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'
import { isDirOf, relayIsDirOf, walkOf } from '../archive_io.ts'
import { dispatchOf } from '../../utils/links.ts'

const tar: CommandFn = async (_accessor, paths, texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  const stat = async (p: PathSpec): Promise<FileStat> => files.stat(p)
  const dispatch = dispatchOf(ctx)
  if (dispatch === undefined) throw new TypeError('tar: no workspace files')
  const fl = new FlagView(ctx.flags, specOf('tar'))
  if (!fl.asBool('create')) {
    // -t reads and -x writes wherever cwd or -C says, which need not
    // be this mount, so both run on dispatch-relayed calls and each
    // path routes to the mount that owns it. Only -c stays on the
    // accessor: its planner walks this mount's tree.
    return tarGeneric(
      resolved,
      texts,
      ctx,
      {
        stream: fileStreamOp(dispatch),
        write: async (p, data) => {
          await dispatch('write', p, [data])
        },
        mkdir: async (p) => {
          await dispatch('mkdir', p)
        },
        stat: statOp(dispatch),
        walk: walkOf(files, dispatch, 'tar'),
        isDir: relayIsDirOf(dispatch),
      },
      true,
    )
  }
  return tarGeneric(resolved, texts, ctx, {
    stream: files.readStream,
    // Archive output follows links even when the member scan preserves them.
    write: async (p, data) => {
      await dispatch('write', p, [data])
    },
    mkdir: (p, parents) => files.mkdir(p, parents),
    stat,
    walk: walkOf(files, dispatch, 'tar'),
    isDir: isDirOf(files),
  })
}

export const BUILDER: GenericCommand = {
  name: 'tar',
  write: true,
  fn: tar,
}
