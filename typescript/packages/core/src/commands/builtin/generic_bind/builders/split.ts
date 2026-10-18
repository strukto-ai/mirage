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

import { splitGeneric } from '../../generic/split.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'
import { dispatchOf } from '../../utils/links.ts'

const split: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const resolved = await resolveOrEmpty(files, paths)
  // The pieces go to the prefix, or `x` in the working directory, which
  // need not be this mount, so the dispatcher routes each write to the mount
  // that owns it. Mirrors the Python builder.
  const dispatch = dispatchOf(ctx)
  if (dispatch === undefined) throw new TypeError('split: no workspace files')
  return splitGeneric(resolved, ctx, files.readStream, async (p, d) => {
    await dispatch('write', p, [d])
  })
}

export const BUILDER: GenericCommand = {
  name: 'split',
  write: true,
  fn: split,
}
