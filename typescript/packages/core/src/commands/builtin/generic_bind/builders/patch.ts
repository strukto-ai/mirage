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
import type { CommandFn } from '../../../config.ts'
import { materialize } from '../../../../io/types.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, dirAwareStat, resolveOrEmpty } from '../files.ts'

const patch: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const stat = dirAwareStat(files, ctx)
  const resolved = await resolveOrEmpty(files, paths)
  // Stat first, as GNU patch does: a directory is refused before it is
  // read, because a store whose read of a collection answers a page
  // (nextcloud) never raises for one. Mirrors Python's patch builder.
  return patchGeneric(
    resolved,
    ctx,
    async (p) => {
      await stat(p)
      return materialize(files.read(p))
    },
    (p, d) => files.write(p, d),
  )
}

export const BUILDER: GenericCommand = {
  name: 'patch',
  write: true,
  fn: patch,
}
