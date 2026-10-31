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

import { facts, uniqFlags, uniqGeneric } from '../../generic/uniq.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, dirAwareStat } from '../files.ts'
import { spreadOperands } from '../../../spec/flag_view.ts'
import type { PathSpec } from '../../../../types.ts'

const uniq: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const groups: PathSpec[][] = []
  for (const path of paths) groups.push(await files.resolveGlob([path]))
  const words = groups.map((group) => group.map((path) => path.rawPath))
  const parsed = uniqFlags(spreadOperands(ctx.flags, words), words.flat())
  if (parsed instanceof IOResult) return [null, parsed]
  return uniqGeneric(
    parsed,
    groups.flat(),
    ctx,
    files.read,
    files.answers('write') ? files.write : undefined,
    dirAwareStat(files, ctx),
  )
}

export const BUILDER: GenericCommand = {
  name: 'uniq',
  facts: facts,
  write: true,
  read: true,
  streams: true,
  fn: uniq,
}
