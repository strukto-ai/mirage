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

import { fileStreamOp, statOp } from '../../generic/crossmount/utils.ts'
import { unzipGeneric } from '../../generic/unzip.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'
import { dispatchOf } from '../../utils/links.ts'

const unzip: CommandFn = async (_accessor, paths, texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  // Extraction writes wherever cwd or -d says, which need not be this
  // mount, so the functions are dispatch-relayed and each path routes to the
  // mount that owns it.
  const dispatch = dispatchOf(ctx)
  if (dispatch === undefined) throw new TypeError('unzip: no workspace files')
  return unzipGeneric(
    resolved,
    texts,
    ctx,
    fileStreamOp(dispatch),
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

export const BUILDER: GenericCommand = {
  name: 'unzip',
  write: true,
  fn: unzip,
}
